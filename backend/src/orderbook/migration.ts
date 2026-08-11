import { randomUUID } from 'node:crypto';

import {
  Prisma,
  type BookMigration,
  type Market,
  type PrismaClient,
  type SignedOrder,
} from '@prisma/client';
import {
  ALLOWED_MINIMUM_TICK_SIZES_RAW,
  ORDER_PRICE_SCALE_RAW,
  assertAllowedMinimumTickSizeRaw,
  floorOrderSizeToGranularity,
  quantizePriceRaw,
} from '@predex-pump/shared';
import {
  CTF_EXCHANGE_PRICE_SCALE,
  Side,
  buildCtfExchangeApprovalForAllTx,
  buildCtfExchangeOrder,
  buildMiniClobCancelTx,
  ctfExchangeOrderTerms,
  generateOrderSalt,
  hashCtfExchangeOrder,
  signCtfExchangeOrder,
} from '@predex-pump/shared/tx';
import {
  isAddressEqual,
  zeroHash,
  type Hex,
  type LocalAccount,
} from 'viem';

import type {
  BookMigrationChainReader,
  BookMigrationChainState,
  FreshOrderChainState,
  OrderChainReader,
} from './chain-reader.js';
import {
  operatorFailure,
  type OperatorLogger,
  type OperatorTransactionSubmitter,
} from './operator.js';
import { signedOrderCreateData, signedOrderFromRow } from './order.js';
import { preflightSignedOrder } from './preflight.js';
import { persistOrderValidationSnapshot } from './service.js';

const CLAIM_LEASE_SECONDS = 120;
const MAX_MIGRATION_PRICE_DEVIATION_RAW =
  ALLOWED_MINIMUM_TICK_SIZES_RAW.at(-1)! - 1n;

/**
 * Durable state machine (all replacement rows remain status=STAGED until the
 * final database transaction):
 *
 *   DISCOVERED ──snapshot/sign──> STAGED
 *       STAGED ──approval needed──> APPROVAL_SUBMITTING
 *          │                            │ send returned hash
 *          │                            v
 *          │                     APPROVAL_SUBMITTED
 *          │                            │ confirmed
 *          └─approval present───────────┴──> CANCELLING
 *                                                │ one seed at a time
 *                                                v
 *                                     CANCEL_SUBMITTING
 *                                          │       │
 *                         transport error  │       │ hash returned
 *                                          v       v
 *                              CANCEL_SUBMISSION_UNKNOWN
 *                                                  CANCEL_SUBMITTED
 *                                          │       │ chain reconciliation
 *                                          └───────┴──> CANCELLING
 *                                                            │ both closed
 *                                                            v
 *                                                       CANCELLED
 *                                                            │ fresh P2 preflight
 *                                                            v
 *                                                       PUBLISHING
 *                                                            │ atomic OPEN + flip
 *                                                            v
 *                                                        MIGRATED
 *
 * APPROVAL_SUBMISSION_UNKNOWN follows the same re-read-before-retry rule.
 * Any in-flight state is restartable; MIGRATED and FAILED are terminal.
 */

export type MigrationIterationResult =
  | { outcome: 'IDLE' | 'SKIPPED' | 'PROGRESSED'; marketId?: string }
  | {
      outcome: 'FAILED';
      marketId: string;
      retryAfterMs: number;
      failureCode: string;
    };

type ClaimedMigration = BookMigration & { market: Market };
type Outcome = 'YES' | 'NO';

class MigrationInvariantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function unixNow(): number {
  return Math.floor(Date.now() / 1_000);
}

function remaining(order: BookMigrationChainState['yesOrder']): bigint {
  const value = order.sizeRaw - order.filledRaw;
  if (value < 0n) {
    throw new MigrationInvariantError(
      'SEED_OVERFILLED',
      `Seed order ${order.orderId} is filled beyond its size`,
    );
  }
  return value;
}

function cancelStatus(order: BookMigrationChainState['yesOrder']): string {
  if (remaining(order) === 0n) return 'FILLED';
  return order.open ? 'PENDING' : 'CONFIRMED';
}

function stateOrder(
  state: BookMigrationChainState,
  outcome: Outcome,
): BookMigrationChainState['yesOrder'] {
  return outcome === 'YES' ? state.yesOrder : state.noOrder;
}

function hasReplacements(migration: BookMigration): boolean {
  return (
    migration.yesReplacementOrderHash !== null ||
    migration.noReplacementOrderHash !== null
  );
}

function safeMessage(code: string): string {
  const messages: Record<string, string> = {
    APPROVAL_REVERTED: 'CTFExchange token approval transaction reverted',
    CANCEL_REVERTED: 'MiniCLOB seed cancellation transaction reverted',
    CANCEL_NOT_APPLIED: 'Confirmed MiniCLOB cancellation left the seed order open',
    INVALID_SEED: 'MiniCLOB seed state does not match the graduated market',
    INVALID_TICK_SIZE: 'Market minimum tick size is outside the supported policy',
    MARKET_RESOLVED: 'Market resolved before its book migration completed',
    MISSING_RECOVERED_BALANCE: 'Recovered position-token balance is below the staged order size',
    MIGRATION_PRICE_OUT_OF_RANGE: 'Tick quantization moved a replacement price outside the supported range',
    MIGRATION_PRICE_DEVIATION: 'Tick quantization exceeded the bounded migration tolerance',
    UNREPRESENTABLE_PRICE: 'Quantized replacement price was not exactly representable',
    TOKEN_NOT_REGISTERED: 'Market position tokens are not registered on CTFExchange',
    WRONG_NONCE: 'Operator nonce changed before migration publication',
  };
  return messages[code] ?? 'Book migration failed an invariant check';
}

export class BookMigrationOperator {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly chainReader: BookMigrationChainReader & OrderChainReader,
    private readonly submitter: OperatorTransactionSubmitter,
    private readonly account: LocalAccount,
    private readonly logger: OperatorLogger,
    private readonly now: () => number = unixNow,
    private readonly claimLeaseSeconds = CLAIM_LEASE_SECONDS,
  ) {}

  async processOnce(): Promise<MigrationIterationResult> {
    const now = this.now();
    await this.detectOne(now);
    const migration = await this.claimOne(now);
    if (migration === null) return { outcome: 'IDLE' };

    try {
      switch (migration.status) {
        case 'DISCOVERED':
        case 'STAGING':
          return await this.stageFromFreshSnapshot(migration);
        case 'STAGED':
          return await this.prepareApprovalOrCancellation(migration);
        case 'APPROVAL_SUBMITTING':
        case 'APPROVAL_SUBMISSION_UNKNOWN':
          return await this.reconcileUnknownApproval(migration);
        case 'APPROVAL_SUBMITTED':
          return await this.confirmApproval(migration);
        case 'CANCELLING':
          return await this.cancelNextSeed(migration);
        case 'CANCEL_SUBMITTING':
        case 'CANCEL_SUBMISSION_UNKNOWN':
          return await this.reconcileUnknownCancel(migration);
        case 'CANCEL_SUBMITTED':
          return await this.confirmCancel(migration);
        case 'CANCELLED':
        case 'PUBLISHING':
          return await this.publish(migration);
        default:
          return await this.failTerminal(
            migration,
            'UNKNOWN_MIGRATION_STATE',
            'Book migration entered an unknown state',
          );
      }
    } catch (error) {
      if (error instanceof MigrationInvariantError) {
        return this.failTerminal(migration, error.code, safeMessage(error.code));
      }
      const failure = operatorFailure(error, migration.attemptCount + 1);
      if (failure.code.startsWith('RPC_')) {
        return this.retry(migration, `READ_${failure.code}`, failure.retryAfterMs);
      }
      return this.failTerminal(
        migration,
        'MIGRATION_FAILED',
        'Book migration failed before an on-chain submission',
      );
    }
  }

  private async detectOne(now: number): Promise<void> {
    const market = await this.prisma.market.findFirst({
      where: {
        phase: 'Graduated',
        bookMigration: null,
        yesSeedOrderId: { not: null },
        noSeedOrderId: { not: null },
        yesTokenId: { not: null },
        noTokenId: { not: null },
        resolution: { is: null },
        orders: { some: { isSeed: true, open: true } },
      },
      orderBy: [{ graduatedAt: 'asc' }, { id: 'asc' }],
    });
    if (
      market === null ||
      market.yesSeedOrderId === null ||
      market.noSeedOrderId === null
    ) {
      return;
    }
    try {
      await this.prisma.bookMigration.create({
        data: {
          marketId: market.id,
          yesSeedOrderId: market.yesSeedOrderId,
          noSeedOrderId: market.noSeedOrderId,
          createdAt: now,
          updatedAt: now,
        },
      });
      this.logger.info(`[migration] market=${market.id} detected`);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return;
      }
      throw error;
    }
  }

  private async claimOne(now: number): Promise<ClaimedMigration | null> {
    const candidates = await this.prisma.bookMigration.findMany({
      where: {
        status: { notIn: ['MIGRATED', 'FAILED'] },
        nextAttemptAt: { lte: now },
        OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }],
      },
      include: { market: true },
      orderBy: [{ createdAt: 'asc' }, { marketId: 'asc' }],
      take: 4,
    });
    for (const candidate of candidates) {
      const claimToken = randomUUID();
      const claimed = await this.prisma.bookMigration.updateMany({
        where: {
          marketId: candidate.marketId,
          status: candidate.status,
          nextAttemptAt: { lte: now },
          OR: [{ claimToken: null }, { claimExpiresAt: { lte: now } }],
        },
        data: {
          claimToken,
          claimExpiresAt: now + this.claimLeaseSeconds,
          updatedAt: now,
        },
      });
      if (claimed.count === 1) {
        return { ...candidate, claimToken, claimExpiresAt: now + this.claimLeaseSeconds };
      }
    }
    return null;
  }

  private stateInput(migration: ClaimedMigration) {
    const market = migration.market;
    if (market.yesTokenId === null || market.noTokenId === null) {
      throw new MigrationInvariantError('INVALID_SEED', 'Market token binding is missing');
    }
    return {
      maker: this.account.address as Hex,
      conditionId: market.conditionId as Hex,
      yesTokenId: BigInt(market.yesTokenId),
      noTokenId: BigInt(market.noTokenId),
      yesSeedOrderId: BigInt(migration.yesSeedOrderId),
      noSeedOrderId: BigInt(migration.noSeedOrderId),
    };
  }

  private async readState(
    migration: ClaimedMigration,
  ): Promise<BookMigrationChainState> {
    const state = await this.chainReader.readBookMigrationState(
      this.stateInput(migration),
    );
    this.validateSeedState(migration.market, state);
    return state;
  }

  private validateSeedState(
    market: Market,
    state: BookMigrationChainState,
  ): void {
    if (state.payoutDenominator !== 0n) {
      throw new MigrationInvariantError('MARKET_RESOLVED', 'Market is resolved');
    }
    if (market.yesTokenId === null || market.noTokenId === null) {
      throw new MigrationInvariantError('INVALID_SEED', 'Market token binding is missing');
    }
    const expected = [
      [state.yesOrder, BigInt(market.yesTokenId)],
      [state.noOrder, BigInt(market.noTokenId)],
    ] as const;
    for (const [order, tokenId] of expected) {
      if (
        !isAddressEqual(order.maker, this.account.address) ||
        order.conditionId.toLowerCase() !== market.conditionId.toLowerCase() ||
        order.tokenId !== tokenId ||
        order.side !== Side.SELL ||
        order.sizeRaw <= 0n ||
        order.priceRaw <= 0n ||
        order.priceRaw > CTF_EXCHANGE_PRICE_SCALE
      ) {
        throw new MigrationInvariantError('INVALID_SEED', 'Seed identity mismatch');
      }
      remaining(order);
    }
    if (
      state.yesOrder.priceRaw + state.noOrder.priceRaw !==
      CTF_EXCHANGE_PRICE_SCALE
    ) {
      throw new MigrationInvariantError('INVALID_SEED', 'Seed prices are not complements');
    }
    if (
      market.frozenYesPriceRaw !== null &&
      BigInt(market.frozenYesPriceRaw) !== state.yesOrder.priceRaw
    ) {
      throw new MigrationInvariantError('INVALID_SEED', 'Frozen price mismatch');
    }
  }

  private async stageFromFreshSnapshot(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    return this.stageFromState(migration, await this.readState(migration));
  }

  private async stageFromState(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): Promise<MigrationIterationResult> {
    const market = migration.market;
    if (market.yesTokenId === null || market.noTokenId === null) {
      throw new MigrationInvariantError('INVALID_SEED', 'Market token binding is missing');
    }
    const minimumTickSizeRaw = BigInt(market.minimumTickSizeRaw);
    try {
      assertAllowedMinimumTickSizeRaw(minimumTickSizeRaw);
    } catch {
      throw new MigrationInvariantError(
        'INVALID_TICK_SIZE',
        'Market minimum tick size is outside the supported policy',
      );
    }
    const yesRealizedPriceRaw = quantizePriceRaw(
      state.yesOrder.priceRaw,
      minimumTickSizeRaw,
      'UP',
    );
    const noRealizedPriceRaw = ORDER_PRICE_SCALE_RAW - yesRealizedPriceRaw;
    if (
      yesRealizedPriceRaw <= 0n ||
      yesRealizedPriceRaw > ORDER_PRICE_SCALE_RAW ||
      noRealizedPriceRaw <= 0n ||
      noRealizedPriceRaw > ORDER_PRICE_SCALE_RAW
    ) {
      throw new MigrationInvariantError(
        'MIGRATION_PRICE_OUT_OF_RANGE',
        'Complementary tick quantization produced an invalid replacement price',
      );
    }
    const yesPriceDeviationRaw =
      yesRealizedPriceRaw - state.yesOrder.priceRaw;
    const noPriceDeviationRaw =
      noRealizedPriceRaw - state.noOrder.priceRaw;
    if (
      yesPriceDeviationRaw < 0n ||
      yesPriceDeviationRaw >= minimumTickSizeRaw ||
      yesPriceDeviationRaw > MAX_MIGRATION_PRICE_DEVIATION_RAW ||
      noPriceDeviationRaw !== -yesPriceDeviationRaw
    ) {
      throw new MigrationInvariantError(
        'MIGRATION_PRICE_DEVIATION',
        'Replacement price exceeded the bounded one-tick migration tolerance',
      );
    }
    const prices = {
      YES: yesRealizedPriceRaw,
      NO: noRealizedPriceRaw,
    } as const;
    const replacements = await Promise.all(
      (['YES', 'NO'] as const).map(async (outcome) => {
        const seed = stateOrder(state, outcome);
        const sizeRaw = floorOrderSizeToGranularity(remaining(seed));
        if (sizeRaw === 0n) return null;
        const salt = generateOrderSalt();
        const unsigned = buildCtfExchangeOrder({
          maker: this.account.address,
          tokenId: seed.tokenId,
          side: Side.SELL,
          priceRaw: prices[outcome],
          sizeRaw,
          nonce: state.makerNonce,
          salt,
        });
        if (ctfExchangeOrderTerms(unsigned).priceRaw !== prices[outcome]) {
          throw new MigrationInvariantError(
            'UNREPRESENTABLE_PRICE',
            'Granular replacement size cannot encode the quantized price exactly',
          );
        }
        const order = await signCtfExchangeOrder(this.account, unsigned);
        return {
          outcome,
          order,
          orderHash: hashCtfExchangeOrder(order).toLowerCase(),
        };
      }),
    );
    const yesReplacement = replacements.find((item) => item?.outcome === 'YES') ?? null;
    const noReplacement = replacements.find((item) => item?.outcome === 'NO') ?? null;
    const oldHashes = [
      migration.yesReplacementOrderHash,
      migration.noReplacementOrderHash,
    ].filter((hash): hash is string => hash !== null);
    const now = this.now();
    await this.prisma.$transaction(async (tx) => {
      if (oldHashes.length > 0) {
        await tx.signedOrder.updateMany({
          where: { orderHash: { in: oldHashes }, status: 'STAGED' },
          data: { status: 'SUPERSEDED', updatedAt: now },
        });
      }
      for (const replacement of replacements) {
        if (replacement === null) continue;
        await tx.signedOrder.create({
          data: signedOrderCreateData({
            orderHash: replacement.orderHash,
            order: replacement.order,
            marketId: market.id,
            conditionId: market.conditionId,
            outcome: replacement.outcome,
            status: 'STAGED',
            origin: 'BOOK_MIGRATION',
            now,
          }),
        });
      }
      const updated = await tx.bookMigration.updateMany({
        where: { marketId: migration.marketId, claimToken: migration.claimToken },
        data: {
          status: 'STAGED',
          snapshotBlockNumber: state.blockNumber,
          snapshotNonceRaw: state.makerNonce.toString(),
          yesPriceRaw: state.yesOrder.priceRaw.toString(),
          noPriceRaw: state.noOrder.priceRaw.toString(),
          yesSnapshotRemainingRaw: remaining(state.yesOrder).toString(),
          noSnapshotRemainingRaw: remaining(state.noOrder).toString(),
          minimumTickSizeRaw: minimumTickSizeRaw.toString(),
          yesRealizedPriceRaw: yesRealizedPriceRaw.toString(),
          noRealizedPriceRaw: noRealizedPriceRaw.toString(),
          yesPriceDeviationRaw: yesPriceDeviationRaw.toString(),
          noPriceDeviationRaw: noPriceDeviationRaw.toString(),
          yesReplacementSizeRaw: floorOrderSizeToGranularity(
            remaining(state.yesOrder),
          ).toString(),
          noReplacementSizeRaw: floorOrderSizeToGranularity(
            remaining(state.noOrder),
          ).toString(),
          yesUnquotedRemainderRaw: (
            remaining(state.yesOrder) -
            floorOrderSizeToGranularity(remaining(state.yesOrder))
          ).toString(),
          noUnquotedRemainderRaw: (
            remaining(state.noOrder) -
            floorOrderSizeToGranularity(remaining(state.noOrder))
          ).toString(),
          yesReplacementOrderHash: yesReplacement?.orderHash ?? null,
          noReplacementOrderHash: noReplacement?.orderHash ?? null,
          approvalStatus: state.ctfApprovedForAll
            ? 'CONFIRMED'
            : replacements.some((replacement) => replacement !== null)
              ? 'PENDING'
              : 'NOT_REQUIRED',
          approvalBlockNumber: state.ctfApprovedForAll
            ? state.blockNumber
            : migration.approvalBlockNumber,
          yesCancelStatus: cancelStatus(state.yesOrder),
          noCancelStatus: cancelStatus(state.noOrder),
          activeCancelOutcome: null,
          nextAttemptAt: 0,
          lastFailureCode: null,
          lastFailureMessage: null,
          lastFailureAt: null,
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        },
      });
      if (updated.count !== 1) throw new Error('Book migration claim was lost');
    });
    this.logger.info(`[migration] market=${migration.marketId} replacements staged`);
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async stagedMatches(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): Promise<boolean> {
    const hashes = [
      migration.yesReplacementOrderHash,
      migration.noReplacementOrderHash,
    ].filter((hash): hash is string => hash !== null);
    const rows = await this.prisma.signedOrder.findMany({
      where: { orderHash: { in: hashes } },
    });
    const byHash = new Map(rows.map((row) => [row.orderHash, row]));
    if (
      migration.minimumTickSizeRaw === null ||
      migration.yesRealizedPriceRaw === null ||
      migration.noRealizedPriceRaw === null ||
      migration.yesSnapshotRemainingRaw !== remaining(state.yesOrder).toString() ||
      migration.noSnapshotRemainingRaw !== remaining(state.noOrder).toString()
    ) {
      return false;
    }
    for (const outcome of ['YES', 'NO'] as const) {
      const expectedSize = floorOrderSizeToGranularity(
        remaining(stateOrder(state, outcome)),
      );
      const expectedPrice = BigInt(
        outcome === 'YES'
          ? migration.yesRealizedPriceRaw
          : migration.noRealizedPriceRaw,
      );
      const hash =
        outcome === 'YES'
          ? migration.yesReplacementOrderHash
          : migration.noReplacementOrderHash;
      if (expectedSize === 0n) {
        if (hash !== null) return false;
        continue;
      }
      if (hash === null) return false;
      const row = byHash.get(hash);
      if (
        row === undefined ||
        row.status !== 'STAGED' ||
        row.origin !== 'BOOK_MIGRATION' ||
        row.outcome !== outcome ||
        BigInt(row.sizeRaw) !== expectedSize ||
        BigInt(row.priceRaw) !== expectedPrice ||
        BigInt(row.nonceRaw) !== state.makerNonce
      ) {
        return false;
      }
    }
    return true;
  }

  private async prepareApprovalOrCancellation(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const state = await this.readState(migration);
    if (!(await this.stagedMatches(migration, state))) {
      return this.stageFromState(migration, state);
    }
    if (!hasReplacements(migration)) {
      await this.checkpoint(migration, {
        status: 'CANCELLING',
        approvalStatus: 'NOT_REQUIRED',
      });
      return { outcome: 'PROGRESSED', marketId: migration.marketId };
    }
    if (state.ctfApprovedForAll) {
      await this.checkpoint(migration, {
        status: 'CANCELLING',
        approvalStatus: 'CONFIRMED',
        approvalBlockNumber: state.blockNumber,
      });
      return { outcome: 'PROGRESSED', marketId: migration.marketId };
    }
    await this.holdCheckpoint(migration, {
      status: 'APPROVAL_SUBMITTING',
      approvalStatus: 'SUBMITTING',
      attemptCount: { increment: 1 },
    });
    let txHash: Hex;
    try {
      txHash = await this.submitter.submit(buildCtfExchangeApprovalForAllTx());
    } catch (error) {
      const failure = operatorFailure(error, migration.attemptCount + 1);
      if (failure.code.startsWith('RPC_')) {
        return this.submissionUnknown(
          migration,
          'APPROVAL_SUBMISSION_UNKNOWN',
          failure,
        );
      }
      return this.failTerminal(
        migration,
        failure.code,
        'CTFExchange token approval submission failed',
      );
    }
    await this.holdCheckpoint(migration, {
      status: 'APPROVAL_SUBMITTED',
      approvalStatus: 'SUBMITTED',
      approvalTxHash: txHash.toLowerCase(),
    });
    return this.confirmApproval({
      ...migration,
      status: 'APPROVAL_SUBMITTED',
      approvalStatus: 'SUBMITTED',
      approvalTxHash: txHash.toLowerCase(),
    });
  }

  private async reconcileUnknownApproval(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const state = await this.readState(migration);
    await this.checkpoint(migration, {
      status: state.ctfApprovedForAll ? 'CANCELLING' : 'STAGED',
      approvalStatus: state.ctfApprovedForAll ? 'CONFIRMED' : 'PENDING',
      approvalBlockNumber: state.ctfApprovedForAll
        ? state.blockNumber
        : migration.approvalBlockNumber,
    });
    this.logger.info(
      `[migration] market=${migration.marketId} ambiguous approval reconciled`,
    );
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async confirmApproval(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    if (migration.approvalTxHash === null) {
      return this.reconcileUnknownApproval(migration);
    }
    let receipt;
    try {
      receipt = await this.submitter.confirm(migration.approvalTxHash as Hex);
    } catch (error) {
      const failure = operatorFailure(error, migration.attemptCount + 1);
      return this.retry(
        migration,
        'APPROVAL_CONFIRMATION_PENDING',
        failure.retryAfterMs,
      );
    }
    if (receipt.status === 'reverted') {
      return this.failTerminal(
        migration,
        'APPROVAL_REVERTED',
        safeMessage('APPROVAL_REVERTED'),
      );
    }
    const state = await this.readState(migration);
    if (hasReplacements(migration) && !state.ctfApprovedForAll) {
      return this.failTerminal(
        migration,
        'APPROVAL_NOT_APPLIED',
        'Confirmed approval did not grant CTFExchange access',
      );
    }
    await this.checkpoint(migration, {
      status: 'CANCELLING',
      approvalStatus: 'CONFIRMED',
      approvalBlockNumber: Math.max(receipt.blockNumber, state.blockNumber),
    });
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async cancelNextSeed(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const state = await this.readState(migration);
    if (hasReplacements(migration) && !state.ctfApprovedForAll) {
      await this.checkpoint(migration, {
        status: 'STAGED',
        approvalStatus: 'PENDING',
      });
      return { outcome: 'PROGRESSED', marketId: migration.marketId };
    }
    if (!(await this.stagedMatches(migration, state))) {
      return this.stageFromState(migration, state);
    }
    const outcome = (['YES', 'NO'] as const).find((candidate) => {
      const order = stateOrder(state, candidate);
      return order.open && remaining(order) > 0n;
    });
    if (outcome === undefined) {
      return this.recordCancellationComplete(migration, state);
    }

    await this.holdCheckpoint(migration, {
      status: 'CANCEL_SUBMITTING',
      activeCancelOutcome: outcome,
      ...(outcome === 'YES'
        ? { yesCancelStatus: 'SUBMITTING' }
        : { noCancelStatus: 'SUBMITTING' }),
      attemptCount: { increment: 1 },
    });
    let txHash: Hex;
    try {
      txHash = await this.submitter.submit(
        buildMiniClobCancelTx({ orderId: stateOrder(state, outcome).orderId }),
      );
    } catch (error) {
      const failure = operatorFailure(error, migration.attemptCount + 1);
      if (failure.code.startsWith('RPC_')) {
        return this.submissionUnknown(
          migration,
          'CANCEL_SUBMISSION_UNKNOWN',
          failure,
          outcome,
        );
      }
      return this.failTerminal(
        migration,
        failure.code,
        'MiniCLOB seed cancellation submission failed',
      );
    }
    await this.holdCheckpoint(migration, {
      status: 'CANCEL_SUBMITTED',
      ...(outcome === 'YES'
        ? { yesCancelStatus: 'SUBMITTED', yesCancelTxHash: txHash.toLowerCase() }
        : { noCancelStatus: 'SUBMITTED', noCancelTxHash: txHash.toLowerCase() }),
    });
    return this.confirmCancel({
      ...migration,
      status: 'CANCEL_SUBMITTED',
      activeCancelOutcome: outcome,
      ...(outcome === 'YES'
        ? { yesCancelStatus: 'SUBMITTED', yesCancelTxHash: txHash.toLowerCase() }
        : { noCancelStatus: 'SUBMITTED', noCancelTxHash: txHash.toLowerCase() }),
    });
  }

  private activeOutcome(migration: ClaimedMigration): Outcome {
    if (
      migration.activeCancelOutcome !== 'YES' &&
      migration.activeCancelOutcome !== 'NO'
    ) {
      throw new MigrationInvariantError(
        'INVALID_CANCEL_STATE',
        'Active cancellation side is missing',
      );
    }
    return migration.activeCancelOutcome;
  }

  private async reconcileUnknownCancel(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const outcome = this.activeOutcome(migration);
    const state = await this.readState(migration);
    const order = stateOrder(state, outcome);
    const closed = !order.open || remaining(order) === 0n;
    await this.checkpoint(migration, {
      status: 'CANCELLING',
      activeCancelOutcome: null,
      ...(outcome === 'YES'
        ? { yesCancelStatus: closed ? cancelStatus(order) : 'PENDING' }
        : { noCancelStatus: closed ? cancelStatus(order) : 'PENDING' }),
      cancelBlockNumber: closed
        ? Math.max(migration.cancelBlockNumber ?? 0, state.blockNumber)
        : migration.cancelBlockNumber,
    });
    this.logger.info(
      `[migration] market=${migration.marketId} ambiguous cancel reconciled side=${outcome}`,
    );
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async confirmCancel(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    const outcome = this.activeOutcome(migration);
    const txHash =
      outcome === 'YES' ? migration.yesCancelTxHash : migration.noCancelTxHash;
    if (txHash === null) return this.reconcileUnknownCancel(migration);
    let receipt;
    try {
      receipt = await this.submitter.confirm(txHash as Hex);
    } catch (error) {
      const failure = operatorFailure(error, migration.attemptCount + 1);
      return this.retry(
        migration,
        'CANCEL_CONFIRMATION_PENDING',
        failure.retryAfterMs,
      );
    }
    const state = await this.readState(migration);
    const order = stateOrder(state, outcome);
    if (receipt.status === 'reverted' && order.open && remaining(order) > 0n) {
      return this.failTerminal(
        migration,
        'CANCEL_REVERTED',
        safeMessage('CANCEL_REVERTED'),
      );
    }
    if (order.open && remaining(order) > 0n) {
      return this.failTerminal(
        migration,
        'CANCEL_NOT_APPLIED',
        safeMessage('CANCEL_NOT_APPLIED'),
      );
    }
    await this.checkpoint(migration, {
      status: 'CANCELLING',
      activeCancelOutcome: null,
      ...(outcome === 'YES'
        ? { yesCancelStatus: cancelStatus(order) }
        : { noCancelStatus: cancelStatus(order) }),
      cancelBlockNumber: Math.max(
        migration.cancelBlockNumber ?? 0,
        receipt.blockNumber,
        state.blockNumber,
      ),
    });
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async recordCancellationComplete(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): Promise<MigrationIterationResult> {
    const now = this.now();
    await this.checkpoint(migration, {
      status: 'CANCELLED',
      yesCancelStatus: cancelStatus(state.yesOrder),
      noCancelStatus: cancelStatus(state.noOrder),
      yesRecoveredRaw: remaining(state.yesOrder).toString(),
      noRecoveredRaw: remaining(state.noOrder).toString(),
      yesBalanceRaw: state.yesBalanceRaw.toString(),
      noBalanceRaw: state.noBalanceRaw.toString(),
      recoveryBlockNumber: state.blockNumber,
      cancelBlockNumber: Math.max(
        migration.cancelBlockNumber ?? 0,
        state.blockNumber,
      ),
      cancelledAt: migration.cancelledAt ?? now,
    });
    this.logger.info(`[migration] market=${migration.marketId} seeds cancelled`);
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private validateRegistration(
    migration: ClaimedMigration,
    state: BookMigrationChainState,
  ): void {
    const { yesTokenId, noTokenId } = this.stateInput(migration);
    if (
      state.yesRegistration.conditionId.toLowerCase() === zeroHash ||
      state.noRegistration.conditionId.toLowerCase() === zeroHash ||
      state.yesRegistration.conditionId.toLowerCase() !==
        migration.market.conditionId.toLowerCase() ||
      state.noRegistration.conditionId.toLowerCase() !==
        migration.market.conditionId.toLowerCase() ||
      state.yesRegistration.complementTokenId !== noTokenId ||
      state.noRegistration.complementTokenId !== yesTokenId
    ) {
      throw new MigrationInvariantError(
        'TOKEN_NOT_REGISTERED',
        'CTFExchange token registration mismatch',
      );
    }
  }

  private validateReplacementPreflight(
    row: SignedOrder,
    state: FreshOrderChainState,
    expectedComplement: bigint,
  ): void {
    const result = preflightSignedOrder({
      order: row,
      state: {
        nonce: state.makerNonce,
        complement: state.complementTokenId,
        conditionId: state.registeredConditionId,
        payoutDenominator: state.payoutDenominator,
        balanceRaw: state.makerAssetBalance,
        approval: state.ctfApprovedForAll ?? false,
      },
      fillSizeRaw: BigInt(row.remainingRaw),
      blockTimestamp: state.blockTimestamp,
      blockNumber: state.blockNumber,
      expectedComplement,
    });
    if (!result.ok) {
      throw new MigrationInvariantError(result.code, result.message);
    }
  }

  private async publish(
    migration: ClaimedMigration,
  ): Promise<MigrationIterationResult> {
    if (migration.status === 'CANCELLED') {
      await this.holdCheckpoint(migration, { status: 'PUBLISHING' });
      migration = { ...migration, status: 'PUBLISHING' };
    }
    const state = await this.readState(migration);
    if (
      (state.yesOrder.open && remaining(state.yesOrder) > 0n) ||
      (state.noOrder.open && remaining(state.noOrder) > 0n)
    ) {
      await this.checkpoint(migration, { status: 'CANCELLING' });
      return { outcome: 'PROGRESSED', marketId: migration.marketId };
    }
    if (!(await this.stagedMatches(migration, state))) {
      return this.stageFromState(migration, state);
    }
    const hashes = [
      migration.yesReplacementOrderHash,
      migration.noReplacementOrderHash,
    ].filter((hash): hash is string => hash !== null);
    if (hashes.length > 0 && !state.ctfApprovedForAll) {
      await this.checkpoint(migration, {
        status: 'STAGED',
        approvalStatus: 'PENDING',
      });
      return { outcome: 'PROGRESSED', marketId: migration.marketId };
    }
    if (hashes.length > 0) this.validateRegistration(migration, state);
    const yesRecovered = remaining(state.yesOrder);
    const noRecovered = remaining(state.noOrder);
    if (
      state.yesBalanceRaw < yesRecovered ||
      state.noBalanceRaw < noRecovered
    ) {
      throw new MigrationInvariantError(
        'MISSING_RECOVERED_BALANCE',
        'Recovered token balance is below the replacement size',
      );
    }

    const rows = await this.prisma.signedOrder.findMany({
      where: { orderHash: { in: hashes }, status: 'STAGED' },
      orderBy: { outcome: 'asc' },
    });
    if (rows.length !== hashes.length) {
      throw new MigrationInvariantError('INVALID_STAGED_ORDER', 'Staged order is missing');
    }
    const validations: Array<{ row: SignedOrder; state: FreshOrderChainState }> = [];
    for (const row of rows) {
      const fresh = await this.chainReader.readOrderState(
        signedOrderFromRow(row),
        migration.market.conditionId as Hex,
      );
      const expectedComplement = BigInt(
        row.outcome === 'YES'
          ? migration.market.noTokenId ?? '0'
          : migration.market.yesTokenId ?? '0',
      );
      this.validateReplacementPreflight(row, fresh, expectedComplement);
      validations.push({ row, state: fresh });
    }

    const now = this.now();
    const recoveryBlock = Math.max(
      state.blockNumber,
      ...validations.map((validation) => validation.state.blockNumber),
    );
    await this.prisma.$transaction(async (tx) => {
      for (const validation of validations) {
        await persistOrderValidationSnapshot(
          tx,
          signedOrderFromRow(validation.row),
          validation.state,
          now,
        );
      }
      const published = await tx.signedOrder.updateMany({
        where: { orderHash: { in: hashes }, status: 'STAGED' },
        data: { status: 'OPEN', updatedAt: now },
      });
      if (published.count !== hashes.length) {
        throw new Error('Staged replacement publication was not atomic');
      }
      const completed = await tx.bookMigration.updateMany({
        where: {
          marketId: migration.marketId,
          claimToken: migration.claimToken,
          status: 'PUBLISHING',
        },
        data: {
          status: 'MIGRATED',
          approvalStatus: hashes.length > 0 ? 'CONFIRMED' : 'NOT_REQUIRED',
          approvalBlockNumber:
            hashes.length > 0
              ? Math.max(migration.approvalBlockNumber ?? 0, state.blockNumber)
              : migration.approvalBlockNumber,
          yesRecoveredRaw: yesRecovered.toString(),
          noRecoveredRaw: noRecovered.toString(),
          yesBalanceRaw: state.yesBalanceRaw.toString(),
          noBalanceRaw: state.noBalanceRaw.toString(),
          recoveryBlockNumber: recoveryBlock,
          migratedAt: now,
          nextAttemptAt: 0,
          lastFailureCode: null,
          lastFailureMessage: null,
          lastFailureAt: null,
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        },
      });
      if (completed.count !== 1) throw new Error('Book migration claim was lost');
    });
    this.logger.info(`[migration] market=${migration.marketId} venue=HYBRID`);
    return { outcome: 'PROGRESSED', marketId: migration.marketId };
  }

  private async holdCheckpoint(
    migration: ClaimedMigration,
    data: Prisma.BookMigrationUpdateManyMutationInput,
  ): Promise<void> {
    const updated = await this.prisma.bookMigration.updateMany({
      where: { marketId: migration.marketId, claimToken: migration.claimToken },
      data: { ...data, updatedAt: this.now() },
    });
    if (updated.count !== 1) throw new Error('Book migration claim was lost');
  }

  private async checkpoint(
    migration: ClaimedMigration,
    data: Prisma.BookMigrationUpdateManyMutationInput,
  ): Promise<void> {
    await this.holdCheckpoint(migration, {
      nextAttemptAt: 0,
      ...data,
      claimToken: null,
      claimExpiresAt: null,
    });
  }

  private async submissionUnknown(
    migration: ClaimedMigration,
    status: 'APPROVAL_SUBMISSION_UNKNOWN' | 'CANCEL_SUBMISSION_UNKNOWN',
    failure: ReturnType<typeof operatorFailure>,
    outcome?: Outcome,
  ): Promise<MigrationIterationResult> {
    const now = this.now();
    await this.checkpoint(migration, {
      status,
      ...(outcome === undefined
        ? { approvalStatus: 'SUBMISSION_UNKNOWN' }
        : outcome === 'YES'
          ? { yesCancelStatus: 'SUBMISSION_UNKNOWN' }
          : { noCancelStatus: 'SUBMISSION_UNKNOWN' }),
      nextAttemptAt: now + Math.max(1, Math.ceil(failure.retryAfterMs / 1_000)),
      lastFailureCode: failure.code,
      lastFailureMessage: 'Transport failed after submission may have been broadcast',
      lastFailureAt: now,
    });
    this.logger.warn(
      `[migration] market=${migration.marketId} code=${failure.code}`,
    );
    return {
      outcome: 'FAILED',
      marketId: migration.marketId,
      retryAfterMs: failure.retryAfterMs,
      failureCode: failure.code,
    };
  }

  private async retry(
    migration: ClaimedMigration,
    failureCode: string,
    retryAfterMs: number,
  ): Promise<MigrationIterationResult> {
    const now = this.now();
    await this.checkpoint(migration, {
      attemptCount: { increment: 1 },
      nextAttemptAt: now + Math.max(1, Math.ceil(retryAfterMs / 1_000)),
      lastFailureCode: failureCode,
      lastFailureMessage: 'Transient migration dependency is unavailable',
      lastFailureAt: now,
    });
    this.logger.warn(`[migration] market=${migration.marketId} code=${failureCode}`);
    return {
      outcome: 'FAILED',
      marketId: migration.marketId,
      retryAfterMs,
      failureCode,
    };
  }

  private async failTerminal(
    migration: ClaimedMigration,
    failureCode: string,
    failureMessage: string,
  ): Promise<MigrationIterationResult> {
    const now = this.now();
    await this.checkpoint(migration, {
      status: 'FAILED',
      lastFailureCode: failureCode,
      lastFailureMessage: failureMessage,
      lastFailureAt: now,
    });
    this.logger.warn(`[migration] market=${migration.marketId} code=${failureCode}`);
    return {
      outcome: 'FAILED',
      marketId: migration.marketId,
      retryAfterMs: 0,
      failureCode,
    };
  }
}
