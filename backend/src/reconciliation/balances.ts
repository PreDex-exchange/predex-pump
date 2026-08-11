import conditionalTokensAbiJson from '@predex-pump/shared/abis/ConditionalTokens.json' with {
  type: 'json',
};
import { ADDRESSES } from '@predex-pump/shared';
import { Side, collateralErc20Abi } from '@predex-pump/shared/tx';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  isAddress,
  type Abi,
  type Address,
  type ContractFunctionParameters,
  type PublicClient,
} from 'viem';

import { lockIndexerCursor } from '../indexer/cursor-lock.js';
import { createArcPublicClient } from '../orderbook/chain-reader.js';

const conditionalTokensAbi = conditionalTokensAbiJson as Abi;
const ACTIVE_ORDER_STATUSES = ['OPEN', 'PARTIALLY_FILLED'] as const;
const MAX_EVENT_LOG_INDEX = 2_147_483_647;
const DEFAULT_MULTICALL_SIZE = 240;
const DEFAULT_CURSOR_RETRIES = 3;

type Outcome = 'YES' | 'NO';
type ReconciledAsset = Outcome | 'COLLATERAL';

export interface PositionBalanceTarget {
  account: Address;
  marketId: string;
  outcome: Outcome;
  tokenId: bigint;
}

export interface CollateralBalanceTarget {
  account: Address;
}

export interface BalanceReadRequest {
  blockNumber: number;
  positions: readonly PositionBalanceTarget[];
  collateral: readonly CollateralBalanceTarget[];
}

export type ChainBalanceResult =
  | { status: 'success'; value: unknown }
  | { status: 'failure'; error: string };

export interface PositionBalanceRead extends PositionBalanceTarget {
  result: ChainBalanceResult;
}

export interface CollateralBalanceRead extends CollateralBalanceTarget {
  result: ChainBalanceResult;
}

export interface BalanceReadResponse {
  positions: PositionBalanceRead[];
  collateral: CollateralBalanceRead[];
  rpcRequestCount: number;
}

export interface BalanceChainReader {
  readBalances(input: BalanceReadRequest): Promise<BalanceReadResponse>;
}

export interface AccountMarketBalanceTarget {
  account: Address;
  marketId: string;
  yesTokenId: bigint;
  noTokenId: bigint;
}

export interface BalanceReconciliationScope {
  accountMarkets: AccountMarketBalanceTarget[];
  collateralAccounts: CollateralBalanceTarget[];
  failures: BalanceReconciliationFailure[];
}

export interface BalanceReconciliationChange {
  account: string;
  marketId: string | null;
  asset: ReconciledAsset;
  previousRaw: string | null;
  chainRaw: string;
  action: 'created' | 'updated';
}

export interface BalanceReconciliationFailure {
  account: string | null;
  marketId: string | null;
  asset:
    | ReconciledAsset
    | 'ACCOUNT_MARKET'
    | 'RPC'
    | 'CURSOR'
    | 'PERSISTENCE';
  error: string;
}

export interface BalanceReconciliationResult {
  snapshotBlock: number;
  scopedAccountMarkets: number;
  scopedCollateralAccounts: number;
  rpcRequestCount: number;
  changes: BalanceReconciliationChange[];
  failures: BalanceReconciliationFailure[];
  unchangedRows: number;
  metadataWrites: number;
  protectedNewerRows: number;
}

export interface BalanceReconciliationOptions {
  gapIds?: readonly number[];
  now?: () => Date;
  maxCursorRetries?: number;
}

interface ContractCallDescriptor {
  contract: ContractFunctionParameters;
  target:
    | { kind: 'position'; value: PositionBalanceTarget }
    | { kind: 'collateral'; value: CollateralBalanceTarget };
}

interface PreparedPositionPair {
  target: AccountMarketBalanceTarget;
  yesRaw: string;
  noRaw: string;
}

interface PreparedCollateral {
  account: Address;
  balanceRaw: string;
}

class CursorMovedError extends Error {}

function positionReadKey(input: {
  account: string;
  marketId: string;
  outcome: Outcome;
}): string {
  return `${input.account.toLowerCase()}:${input.marketId}:${input.outcome}`;
}

function accountMarketKey(input: { account: string; marketId: string }): string {
  return `${input.account.toLowerCase()}:${input.marketId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeAddress(
  value: string,
  marketId: string,
  failures: BalanceReconciliationFailure[],
): Address | null {
  if (!isAddress(value)) {
    failures.push({
      account: value,
      marketId,
      asset: 'ACCOUNT_MARKET',
      error: 'Indexed account is not a valid EVM address',
    });
    return null;
  }
  return value.toLowerCase() as Address;
}

function safeTokenId(
  value: string | null,
  account: Address,
  marketId: string,
  outcome: Outcome,
  failures: BalanceReconciliationFailure[],
): bigint | null {
  if (value === null) {
    failures.push({
      account,
      marketId,
      asset: outcome,
      error: `Market ${marketId} has no indexed ${outcome} token id`,
    });
    return null;
  }
  try {
    const tokenId = BigInt(value);
    if (tokenId < 0n) throw new Error('negative token id');
    return tokenId;
  } catch {
    failures.push({
      account,
      marketId,
      asset: outcome,
      error: `Market ${marketId} has a malformed ${outcome} token id`,
    });
    return null;
  }
}

/**
 * Bound RPC work to balances that can affect a live book or a currently
 * materialized holding:
 * - maker/market pairs on open signed orders;
 * - maker/market pairs on resting MiniCLOB orders; and
 * - account/market pairs with a non-zero indexed position.
 *
 * Both outcomes are read for every selected pair so a completely absent row
 * is recoverable. USDC is account-level and affects fillability only for open
 * signed BUY orders, so those makers are the collateral scope.
 */
export async function discoverBalanceReconciliationScope(
  prisma: PrismaClient | Prisma.TransactionClient,
): Promise<BalanceReconciliationScope> {
  const [signedOrders, restingOrders, indexedPositions] = await Promise.all([
    prisma.signedOrder.findMany({
      where: {
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        withdrawnAt: null,
      },
      select: { maker: true, marketId: true, exchangeSide: true },
    }),
    prisma.order.findMany({
      where: { open: true },
      select: { maker: true, marketId: true },
    }),
    prisma.position.findMany({
      where: { qtyRaw: { not: '0' } },
      select: { account: true, marketId: true },
    }),
  ]);

  const failures: BalanceReconciliationFailure[] = [];
  const pairSeeds = new Map<string, { account: string; marketId: string }>();
  for (const row of [...signedOrders, ...restingOrders]) {
    pairSeeds.set(accountMarketKey({ account: row.maker, marketId: row.marketId }), {
      account: row.maker,
      marketId: row.marketId,
    });
  }
  for (const row of indexedPositions) {
    pairSeeds.set(
      accountMarketKey({ account: row.account, marketId: row.marketId }),
      { account: row.account, marketId: row.marketId },
    );
  }

  const marketIds = [...new Set([...pairSeeds.values()].map((row) => row.marketId))];
  const markets =
    marketIds.length === 0
      ? []
      : await prisma.market.findMany({
          where: { id: { in: marketIds } },
          select: { id: true, yesTokenId: true, noTokenId: true },
        });
  const marketById = new Map(markets.map((market) => [market.id, market]));
  const accountMarkets: AccountMarketBalanceTarget[] = [];

  for (const seed of [...pairSeeds.values()].sort((left, right) =>
    accountMarketKey(left).localeCompare(accountMarketKey(right)),
  )) {
    const account = safeAddress(seed.account, seed.marketId, failures);
    if (account === null) continue;
    const market = marketById.get(seed.marketId);
    if (market === undefined) {
      failures.push({
        account,
        marketId: seed.marketId,
        asset: 'ACCOUNT_MARKET',
        error: `Indexed balance scope refers to missing market ${seed.marketId}`,
      });
      continue;
    }
    const yesTokenId = safeTokenId(
      market.yesTokenId,
      account,
      market.id,
      'YES',
      failures,
    );
    const noTokenId = safeTokenId(
      market.noTokenId,
      account,
      market.id,
      'NO',
      failures,
    );
    if (yesTokenId === null || noTokenId === null) continue;
    accountMarkets.push({
      account,
      marketId: market.id,
      yesTokenId,
      noTokenId,
    });
  }

  const collateralAccounts = [
    ...new Set(
      signedOrders
        .filter((order) => order.exchangeSide === Side.BUY)
        .map((order) => order.maker.toLowerCase()),
    ),
  ]
    .sort()
    .flatMap((account) => {
      if (!isAddress(account)) {
        failures.push({
          account,
          marketId: null,
          asset: 'COLLATERAL',
          error: 'Indexed collateral owner is not a valid EVM address',
        });
        return [];
      }
      return [{ account: account as Address }];
    });

  return { accountMarkets, collateralAccounts, failures };
}

export class ViemBalanceChainReader implements BalanceChainReader {
  constructor(
    private readonly client: PublicClient = createArcPublicClient(),
    private readonly multicallSize = DEFAULT_MULTICALL_SIZE,
  ) {
    if (!Number.isSafeInteger(multicallSize) || multicallSize <= 0) {
      throw new Error('multicallSize must be a positive safe integer');
    }
  }

  async readBalances(input: BalanceReadRequest): Promise<BalanceReadResponse> {
    const descriptors: ContractCallDescriptor[] = [
      ...input.positions.map(
        (target): ContractCallDescriptor => ({
          target: { kind: 'position', value: target },
          contract: {
            address: ADDRESSES.ctf,
            abi: conditionalTokensAbi,
            functionName: 'balanceOf',
            args: [target.account, target.tokenId],
          },
        }),
      ),
      ...input.collateral.map(
        (target): ContractCallDescriptor => ({
          target: { kind: 'collateral', value: target },
          contract: {
            address: ADDRESSES.usdc,
            abi: collateralErc20Abi as Abi,
            functionName: 'balanceOf',
            args: [target.account],
          },
        }),
      ),
    ];
    const positions: PositionBalanceRead[] = [];
    const collateral: CollateralBalanceRead[] = [];
    let rpcRequestCount = 0;

    for (let offset = 0; offset < descriptors.length; offset += this.multicallSize) {
      const chunk = descriptors.slice(offset, offset + this.multicallSize);
      rpcRequestCount += 1;
      const results = await this.client.multicall({
        allowFailure: true,
        blockNumber: BigInt(input.blockNumber),
        contracts: chunk.map((descriptor) => descriptor.contract),
      });
      if (results.length !== chunk.length) {
        throw new Error(
          `Arc multicall returned ${results.length} results for ${chunk.length} requests`,
        );
      }
      for (let index = 0; index < chunk.length; index += 1) {
        const descriptor = chunk[index];
        const result = results[index];
        if (descriptor === undefined || result === undefined) {
          throw new Error('Arc multicall result mapping was incomplete');
        }
        const mapped: ChainBalanceResult =
          result.status === 'success'
            ? { status: 'success', value: result.result }
            : { status: 'failure', error: errorMessage(result.error) };
        if (descriptor.target.kind === 'position') {
          positions.push({ ...descriptor.target.value, result: mapped });
        } else {
          collateral.push({ ...descriptor.target.value, result: mapped });
        }
      }
    }

    return { positions, collateral, rpcRequestCount };
  }
}

function parsedBalance(
  result: ChainBalanceResult | undefined,
): { ok: true; raw: string } | { ok: false; error: string } {
  if (result === undefined) {
    return { ok: false, error: 'Chain reader omitted this balance' };
  }
  if (result.status === 'failure') {
    return { ok: false, error: `Chain read failed: ${result.error}` };
  }
  if (typeof result.value !== 'bigint' || result.value < 0n) {
    return {
      ok: false,
      error: 'Chain read was malformed: expected a non-negative bigint',
    };
  }
  return { ok: true, raw: result.value.toString() };
}

function failureSummary(failures: readonly BalanceReconciliationFailure[]): string {
  return failures
    .slice(0, 10)
    .map((failure) => {
      const account = failure.account ?? 'unknown';
      const market = failure.marketId ?? 'all';
      return `${account}/market=${market}/asset=${failure.asset}: ${failure.error}`;
    })
    .join('; ');
}

async function recordFailedGaps(
  prisma: PrismaClient,
  gapIds: readonly number[],
  blockNumber: number,
  attemptedAt: Date,
  error: string,
): Promise<void> {
  if (gapIds.length === 0) return;
  await prisma.indexerGap.updateMany({
    where: {
      id: { in: [...gapIds] },
      balanceReconciliationStatus: { not: 'COMPLETE' },
    },
    data: {
      balanceReconciliationStatus: 'FAILED',
      balanceReconciliationBlock: blockNumber,
      balanceReconciliationAttemptedAt: attemptedAt,
      balanceReconciledAt: null,
      balanceReconciliationError: error,
    },
  });
}

function prepareReads(
  scope: BalanceReconciliationScope,
  reads: BalanceReadResponse,
): {
  positionPairs: PreparedPositionPair[];
  collateral: PreparedCollateral[];
  failures: BalanceReconciliationFailure[];
} {
  const failures = [...scope.failures];
  const positionResults = new Map(
    reads.positions.map((read) => [positionReadKey(read), read.result]),
  );
  const collateralResults = new Map(
    reads.collateral.map((read) => [read.account.toLowerCase(), read.result]),
  );
  const positionPairs: PreparedPositionPair[] = [];

  for (const target of scope.accountMarkets) {
    const yes = parsedBalance(
      positionResults.get(
        positionReadKey({ ...target, outcome: 'YES' }),
      ),
    );
    const no = parsedBalance(
      positionResults.get(
        positionReadKey({ ...target, outcome: 'NO' }),
      ),
    );
    if (!yes.ok || !no.ok) {
      if (!yes.ok) {
        failures.push({
          account: target.account,
          marketId: target.marketId,
          asset: 'YES',
          error: yes.error,
        });
      }
      if (!no.ok) {
        failures.push({
          account: target.account,
          marketId: target.marketId,
          asset: 'NO',
          error: no.error,
        });
      }
      // YES and NO form one account/market repair unit. If either read is bad,
      // write neither side.
      continue;
    }
    positionPairs.push({ target, yesRaw: yes.raw, noRaw: no.raw });
  }

  const collateral: PreparedCollateral[] = [];
  for (const target of scope.collateralAccounts) {
    const parsed = parsedBalance(collateralResults.get(target.account.toLowerCase()));
    if (!parsed.ok) {
      failures.push({
        account: target.account,
        marketId: null,
        asset: 'COLLATERAL',
        error: parsed.error,
      });
      continue;
    }
    collateral.push({ account: target.account, balanceRaw: parsed.raw });
  }
  return { positionPairs, collateral, failures };
}

async function persistPreparedBalances(
  prisma: PrismaClient,
  input: {
    snapshotBlock: number;
    attemptedAt: Date;
    gapIds: readonly number[];
    positionPairs: readonly PreparedPositionPair[];
    collateral: readonly PreparedCollateral[];
    readFailures: readonly BalanceReconciliationFailure[];
  },
): Promise<{
  changes: BalanceReconciliationChange[];
  failures: BalanceReconciliationFailure[];
  unchangedRows: number;
  metadataWrites: number;
  protectedNewerRows: number;
}> {
  return prisma.$transaction(
    async (tx) => {
      const cursor = await lockIndexerCursor(tx);
      if (cursor.lastBlock !== input.snapshotBlock) {
        throw new CursorMovedError(
          `Indexer cursor moved from ${input.snapshotBlock} to ${cursor.lastBlock} during reconciliation`,
        );
      }

      const changes: BalanceReconciliationChange[] = [];
      const failures = [...input.readFailures];
      let unchangedRows = 0;
      let metadataWrites = 0;
      let protectedNewerRows = 0;
      const updatedAt = Math.floor(input.attemptedAt.getTime() / 1_000);

      for (const pair of input.positionPairs) {
        const selectors = (['YES', 'NO'] as const).map((outcome) => ({
          account: pair.target.account,
          marketId: pair.target.marketId,
          outcome,
        }));
        const existingRows = await tx.position.findMany({
          where: { OR: selectors },
        });
        const existingByOutcome = new Map(
          existingRows.map((position) => [position.outcome, position]),
        );
        if (
          existingRows.some(
            (position) =>
              position.balanceReconciledBlock !== null &&
              position.balanceReconciledBlock > input.snapshotBlock,
          )
        ) {
          protectedNewerRows += 2;
          continue;
        }

        for (const outcome of ['YES', 'NO'] as const) {
          const chainRaw = outcome === 'YES' ? pair.yesRaw : pair.noRaw;
          const existing = existingByOutcome.get(outcome);
          const selector = {
            account_marketId_outcome: {
              account: pair.target.account,
              marketId: pair.target.marketId,
              outcome,
            },
          };
          if (existing === undefined) {
            await tx.position.create({
              data: {
                account: pair.target.account,
                marketId: pair.target.marketId,
                outcome,
                qtyRaw: chainRaw,
                balanceReconciledBlock: input.snapshotBlock,
                updatedAt,
              },
            });
            changes.push({
              account: pair.target.account,
              marketId: pair.target.marketId,
              asset: outcome,
              previousRaw: null,
              chainRaw,
              action: 'created',
            });
            continue;
          }

          const valueChanged = existing.qtyRaw !== chainRaw;
          const metadataChanged =
            existing.balanceReconciledBlock !== input.snapshotBlock;
          if (valueChanged || metadataChanged) {
            await tx.position.update({
              where: selector,
              data: {
                qtyRaw: chainRaw,
                balanceReconciledBlock: input.snapshotBlock,
                ...(valueChanged ? { updatedAt } : {}),
              },
            });
            if (valueChanged) {
              changes.push({
                account: pair.target.account,
                marketId: pair.target.marketId,
                asset: outcome,
                previousRaw: existing.qtyRaw,
                chainRaw,
                action: 'updated',
              });
            } else {
              metadataWrites += 1;
            }
          } else {
            unchangedRows += 1;
          }
        }
      }

      for (const target of input.collateral) {
        const existing = await tx.collateralBalance.findUnique({
          where: { owner: target.account },
        });
        const existingIsNewer =
          existing !== null &&
          (existing.blockNumber > input.snapshotBlock ||
            (existing.blockNumber === input.snapshotBlock &&
              existing.logIndex > MAX_EVENT_LOG_INDEX));
        if (existingIsNewer) {
          protectedNewerRows += 1;
          continue;
        }
        if (existing === null) {
          await tx.collateralBalance.create({
            data: {
              owner: target.account,
              balanceRaw: target.balanceRaw,
              blockNumber: input.snapshotBlock,
              logIndex: MAX_EVENT_LOG_INDEX,
              updatedAt,
            },
          });
          changes.push({
            account: target.account,
            marketId: null,
            asset: 'COLLATERAL',
            previousRaw: null,
            chainRaw: target.balanceRaw,
            action: 'created',
          });
          continue;
        }

        const valueChanged = existing.balanceRaw !== target.balanceRaw;
        const metadataChanged =
          existing.blockNumber !== input.snapshotBlock ||
          existing.logIndex !== MAX_EVENT_LOG_INDEX;
        if (valueChanged || metadataChanged) {
          await tx.collateralBalance.update({
            where: { owner: target.account },
            data: {
              balanceRaw: target.balanceRaw,
              blockNumber: input.snapshotBlock,
              logIndex: MAX_EVENT_LOG_INDEX,
              ...(valueChanged ? { updatedAt } : {}),
            },
          });
          if (valueChanged) {
            changes.push({
              account: target.account,
              marketId: null,
              asset: 'COLLATERAL',
              previousRaw: existing.balanceRaw,
              chainRaw: target.balanceRaw,
              action: 'updated',
            });
          } else {
            metadataWrites += 1;
          }
        } else {
          unchangedRows += 1;
        }
      }

      if (input.gapIds.length > 0) {
        const complete = failures.length === 0;
        await tx.indexerGap.updateMany({
          where: {
            id: { in: [...input.gapIds] },
            balanceReconciliationStatus: { not: 'COMPLETE' },
          },
          data: {
            balanceReconciliationStatus: complete ? 'COMPLETE' : 'FAILED',
            balanceReconciliationBlock: input.snapshotBlock,
            balanceReconciliationAttemptedAt: input.attemptedAt,
            balanceReconciledAt: complete ? input.attemptedAt : null,
            balanceReconciliationError: complete
              ? null
              : failureSummary(failures),
          },
        });
      }

      return {
        changes,
        failures,
        unchangedRows,
        metadataWrites,
        protectedNewerRows,
      };
    },
    {
      maxWait: 30_000,
      timeout: 120_000,
      isolationLevel: 'Serializable',
    },
  );
}

export async function reconcileIndexedBalances(
  prisma: PrismaClient,
  reader: BalanceChainReader = new ViemBalanceChainReader(),
  options: BalanceReconciliationOptions = {},
): Promise<BalanceReconciliationResult> {
  const now = options.now ?? (() => new Date());
  const gapIds = [...new Set(options.gapIds ?? [])];
  const maxCursorRetries = options.maxCursorRetries ?? DEFAULT_CURSOR_RETRIES;
  if (!Number.isSafeInteger(maxCursorRetries) || maxCursorRetries <= 0) {
    throw new Error('maxCursorRetries must be a positive safe integer');
  }

  let lastSnapshotBlock = 0;
  let lastScope: BalanceReconciliationScope = {
    accountMarkets: [],
    collateralAccounts: [],
    failures: [],
  };
  let rpcRequestCount = 0;
  for (let attempt = 1; attempt <= maxCursorRetries; attempt += 1) {
    const state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    const snapshotBlock = state.lastBlock;
    lastSnapshotBlock = snapshotBlock;
    const scope = await discoverBalanceReconciliationScope(prisma);
    lastScope = scope;
    const positionTargets = scope.accountMarkets.flatMap((target) => [
      {
        account: target.account,
        marketId: target.marketId,
        outcome: 'YES' as const,
        tokenId: target.yesTokenId,
      },
      {
        account: target.account,
        marketId: target.marketId,
        outcome: 'NO' as const,
        tokenId: target.noTokenId,
      },
    ]);
    const attemptedAt = now();
    let reads: BalanceReadResponse;
    try {
      reads = await reader.readBalances({
        blockNumber: snapshotBlock,
        positions: positionTargets,
        collateral: scope.collateralAccounts,
      });
      rpcRequestCount += reads.rpcRequestCount;
    } catch (error) {
      const failure: BalanceReconciliationFailure = {
        account: null,
        marketId: null,
        asset: 'RPC',
        error: `Batched chain read failed: ${errorMessage(error)}`,
      };
      await recordFailedGaps(
        prisma,
        gapIds,
        snapshotBlock,
        attemptedAt,
        failure.error,
      );
      return {
        snapshotBlock,
        scopedAccountMarkets: scope.accountMarkets.length,
        scopedCollateralAccounts: scope.collateralAccounts.length,
        rpcRequestCount,
        changes: [],
        failures: [...scope.failures, failure],
        unchangedRows: 0,
        metadataWrites: 0,
        protectedNewerRows: 0,
      };
    }

    const prepared = prepareReads(scope, reads);
    try {
      const persisted = await persistPreparedBalances(prisma, {
        snapshotBlock,
        attemptedAt,
        gapIds,
        positionPairs: prepared.positionPairs,
        collateral: prepared.collateral,
        readFailures: prepared.failures,
      });
      return {
        snapshotBlock,
        scopedAccountMarkets: scope.accountMarkets.length,
        scopedCollateralAccounts: scope.collateralAccounts.length,
        rpcRequestCount,
        ...persisted,
      };
    } catch (error) {
      if (error instanceof CursorMovedError && attempt < maxCursorRetries) {
        continue;
      }
      const failure: BalanceReconciliationFailure = {
        account: null,
        marketId: null,
        asset: error instanceof CursorMovedError ? 'CURSOR' : 'PERSISTENCE',
        error: errorMessage(error),
      };
      await recordFailedGaps(
        prisma,
        gapIds,
        snapshotBlock,
        attemptedAt,
        failure.error,
      );
      return {
        snapshotBlock,
        scopedAccountMarkets: scope.accountMarkets.length,
        scopedCollateralAccounts: scope.collateralAccounts.length,
        rpcRequestCount,
        changes: [],
        failures: [...prepared.failures, failure],
        unchangedRows: 0,
        metadataWrites: 0,
        protectedNewerRows: 0,
      };
    }
  }

  return {
    snapshotBlock: lastSnapshotBlock,
    scopedAccountMarkets: lastScope.accountMarkets.length,
    scopedCollateralAccounts: lastScope.collateralAccounts.length,
    rpcRequestCount,
    changes: [],
    failures: [
      ...lastScope.failures,
      {
        account: null,
        marketId: null,
        asset: 'CURSOR',
        error: 'Indexer cursor kept moving during balance reconciliation',
      },
    ],
    unchangedRows: 0,
    metadataWrites: 0,
    protectedNewerRows: 0,
  };
}

export async function outstandingBalanceGapIds(
  prisma: PrismaClient,
): Promise<number[]> {
  return (
    await prisma.indexerGap.findMany({
      where: { balanceReconciliationStatus: { not: 'COMPLETE' } },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    })
  ).map((gap) => gap.id);
}

export function formatBalanceReconciliationChange(
  change: BalanceReconciliationChange,
): string {
  return (
    `[reconcile-balances] account=${change.account} ` +
    `market=${change.marketId ?? 'all'} asset=${change.asset} ` +
    `previous=${change.previousRaw ?? 'MISSING'} chain=${change.chainRaw} ` +
    `action=${change.action}`
  );
}
