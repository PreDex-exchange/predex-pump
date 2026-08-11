import { ADDRESSES } from '@predex-pump/shared';
import { Side } from '@predex-pump/shared/tx';
import type { PublicClient } from 'viem';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMarketBook } from '../src/api/queries.js';
import { ServerEventBus } from '../src/events/bus.js';
import { applyDecodedEvents } from '../src/indexer/runner.js';
import type { DecodedEvent } from '../src/indexer/types.js';
import { OffchainOrderService } from '../src/orderbook/service.js';
import {
  reconcileIndexedBalances,
  ViemBalanceChainReader,
  type BalanceChainReader,
  type BalanceReadRequest,
  type BalanceReadResponse,
  type ChainBalanceResult,
} from '../src/reconciliation/balances.js';
import { resetDatabase, testPrisma } from './database.js';
import {
  OTHER_CREATOR,
  TRADE_TX,
  TRADER,
  seedContractData,
} from './fixtures.js';
import {
  BOOK_NOW,
  FakeOrderChainReader,
  signedOrderRequest,
  validChainState,
} from './orderbook-fixtures.js';

function positionKey(input: {
  account: string;
  marketId: string;
  outcome: string;
}): string {
  return `${input.account.toLowerCase()}:${input.marketId}:${input.outcome}`;
}

class FakeBalanceReader implements BalanceChainReader {
  readonly requests: BalanceReadRequest[] = [];
  readonly positions = new Map<string, ChainBalanceResult>();
  readonly collateral = new Map<string, ChainBalanceResult>();

  setPosition(
    account: string,
    marketId: string,
    outcome: 'YES' | 'NO',
    result: ChainBalanceResult,
  ): void {
    this.positions.set(positionKey({ account, marketId, outcome }), result);
  }

  setCollateral(account: string, result: ChainBalanceResult): void {
    this.collateral.set(account.toLowerCase(), result);
  }

  async readBalances(input: BalanceReadRequest): Promise<BalanceReadResponse> {
    this.requests.push(input);
    return {
      positions: input.positions.map((target) => ({
        ...target,
        result: this.positions.get(positionKey(target)) ?? {
          status: 'failure',
          error: 'unexpected position target',
        },
      })),
      collateral: input.collateral.map((target) => ({
        ...target,
        result: this.collateral.get(target.account.toLowerCase()) ?? {
          status: 'failure',
          error: 'unexpected collateral target',
        },
      })),
      rpcRequestCount:
        input.positions.length + input.collateral.length === 0 ? 0 : 1,
    };
  }
}

async function clearBalanceScope(): Promise<void> {
  await testPrisma.$transaction([
    testPrisma.signedOrder.deleteMany(),
    testPrisma.order.deleteMany(),
    testPrisma.position.deleteMany(),
    testPrisma.collateralBalance.deleteMany(),
  ]);
}

async function createYesPosition(qtyRaw: string): Promise<void> {
  await testPrisma.position.create({
    data: {
      account: TRADER,
      marketId: '1',
      outcome: 'YES',
      qtyRaw,
      updatedAt: 1_700_000_020,
    },
  });
}

async function createGap(): Promise<number> {
  return (
    await testPrisma.indexerGap.create({
      data: {
        chainId: 5_042_002,
        skippedFromBlock: 91,
        skippedToBlock: 99,
        skippedBlockCount: 9,
        cursorBefore: 90,
        cursorAfter: 99,
        headBlock: 100,
        startPolicy: 'auto',
        reason: 'threshold_exceeded',
        maxBackfillBlocks: 5,
      },
    })
  ).id;
}

function successful(value: bigint): ChainBalanceResult {
  return { status: 'success', value };
}

describe('indexed balance reconciliation', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedContractData();
    await clearBalanceScope();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it('corrects a position that is understated relative to chain', async () => {
    await createYesPosition('550000');
    const reader = new FakeBalanceReader();
    reader.setPosition(TRADER, '1', 'YES', successful(1_000_000n));
    reader.setPosition(TRADER, '1', 'NO', successful(0n));

    const result = await reconcileIndexedBalances(testPrisma, reader);

    expect(
      await testPrisma.position.findUniqueOrThrow({
        where: {
          account_marketId_outcome: {
            account: TRADER,
            marketId: '1',
            outcome: 'YES',
          },
        },
      }),
    ).toMatchObject({
      qtyRaw: '1000000',
      balanceReconciledBlock: 100,
    });
    expect(result.changes).toContainEqual({
      account: TRADER,
      marketId: '1',
      asset: 'YES',
      previousRaw: '550000',
      chainRaw: '1000000',
      action: 'updated',
    });
  });

  it('creates the entirely missing outcome row from chain truth', async () => {
    await createYesPosition('1000000');
    const reader = new FakeBalanceReader();
    reader.setPosition(TRADER, '1', 'YES', successful(1_000_000n));
    reader.setPosition(TRADER, '1', 'NO', successful(900_000n));

    const result = await reconcileIndexedBalances(testPrisma, reader);

    expect(
      await testPrisma.position.findUniqueOrThrow({
        where: {
          account_marketId_outcome: {
            account: TRADER,
            marketId: '1',
            outcome: 'NO',
          },
        },
      }),
    ).toMatchObject({ qtyRaw: '900000', balanceReconciledBlock: 100 });
    expect(result.changes).toContainEqual({
      account: TRADER,
      marketId: '1',
      asset: 'NO',
      previousRaw: null,
      chainRaw: '900000',
      action: 'created',
    });
  });

  it('is idempotent when run twice at the same cursor', async () => {
    await createYesPosition('550000');
    const reader = new FakeBalanceReader();
    reader.setPosition(TRADER, '1', 'YES', successful(1_000_000n));
    reader.setPosition(TRADER, '1', 'NO', successful(900_000n));

    const first = await reconcileIndexedBalances(testPrisma, reader);
    const afterFirst = await testPrisma.position.findMany({
      orderBy: { outcome: 'asc' },
    });
    const second = await reconcileIndexedBalances(testPrisma, reader);
    const afterSecond = await testPrisma.position.findMany({
      orderBy: { outcome: 'asc' },
    });

    expect(first.changes).toHaveLength(2);
    expect(second).toMatchObject({
      changes: [],
      failures: [],
      metadataWrites: 0,
      unchangedRows: 2,
    });
    expect(afterSecond).toEqual(afterFirst);
  });

  it.each([
    ['failed', { status: 'failure', error: 'RPC timeout' } as const],
    ['malformed', { status: 'success', value: '0' } as const],
  ])(
    'leaves the account/market untouched after a %s chain read',
    async (_label, badRead) => {
      await createYesPosition('550000');
      const before = await testPrisma.position.findMany();
      const reader = new FakeBalanceReader();
      reader.setPosition(TRADER, '1', 'YES', badRead);
      reader.setPosition(TRADER, '1', 'NO', successful(900_000n));
      const gapId = await createGap();

      const result = await reconcileIndexedBalances(testPrisma, reader, {
        gapIds: [gapId],
      });

      expect(result.changes).toEqual([]);
      expect(result.failures).toHaveLength(1);
      expect(await testPrisma.position.findMany()).toEqual(before);
      expect(
        await testPrisma.position.findUnique({
          where: {
            account_marketId_outcome: {
              account: TRADER,
              marketId: '1',
              outcome: 'NO',
            },
          },
        }),
      ).toBeNull();
      expect(
        (await testPrisma.position.findUniqueOrThrow({
          where: {
            account_marketId_outcome: {
              account: TRADER,
              marketId: '1',
              outcome: 'YES',
            },
          },
        })).qtyRaw,
      ).not.toBe('0');
      expect(
        await testPrisma.indexerGap.findUniqueOrThrow({ where: { id: gapId } }),
      ).toMatchObject({
        balanceReconciliationStatus: 'FAILED',
        balanceReconciliationBlock: 100,
        balanceReconciledAt: null,
      });
    },
  );

  it('does not issue reads for an account with no open orders or non-zero position', async () => {
    await createYesPosition('1');
    const reader = new FakeBalanceReader();
    reader.setPosition(TRADER, '1', 'YES', successful(1n));
    reader.setPosition(TRADER, '1', 'NO', successful(0n));

    const result = await reconcileIndexedBalances(testPrisma, reader);

    expect(result).toMatchObject({
      scopedAccountMarkets: 1,
      scopedCollateralAccounts: 0,
      rpcRequestCount: 1,
      failures: [],
    });
    expect(reader.requests).toHaveLength(1);
    expect(reader.requests[0]?.positions).toHaveLength(2);
    expect(
      reader.requests[0]?.positions.some(
        (target) => target.account.toLowerCase() === OTHER_CREATOR,
      ),
    ).toBe(false);
  });

  it('batches CTF and USDC reads through one cursor-pinned multicall', async () => {
    const multicall = vi.fn(async () => [
      { status: 'success' as const, result: 1n },
      { status: 'success' as const, result: 2n },
      { status: 'success' as const, result: 3n },
    ]);
    const reader = new ViemBalanceChainReader(
      { multicall } as unknown as PublicClient,
      10,
    );

    const result = await reader.readBalances({
      blockNumber: 100,
      positions: [
        { account: TRADER, marketId: '1', outcome: 'YES', tokenId: 101n },
        { account: TRADER, marketId: '1', outcome: 'NO', tokenId: 102n },
      ],
      collateral: [{ account: TRADER }],
    });

    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 100n, allowFailure: true }),
    );
    expect(result).toMatchObject({ rpcRequestCount: 1 });
    expect(result.positions.map((read) => read.result)).toEqual([
      successful(1n),
      successful(2n),
    ]);
    expect(result.collateral[0]?.result).toEqual(successful(3n));
  });

  it('creates missing USDC state only for makers whose open BUY orders use it', async () => {
    const orderReader = new FakeOrderChainReader();
    const service = new OffchainOrderService(
      testPrisma,
      orderReader,
      new ServerEventBus(),
      () => BOOK_NOW,
    );
    const created = await signedOrderRequest({
      side: Side.BUY,
      priceRaw: 600_000n,
      sizeRaw: 1_000_000n,
      salt: 701n,
    });
    orderReader.state = validChainState({
      blockNumber: 90,
      makerAssetBalance: 2_000_000n,
      approvalKind: 'COLLATERAL_ALLOWANCE',
      collateralAllowance: 2_000_000n,
      ctfApprovedForAll: null,
    });
    await service.ingest(created.request);
    const maker = created.account.address.toLowerCase();
    await testPrisma.collateralBalance.delete({ where: { owner: maker } });
    const reader = new FakeBalanceReader();
    reader.setPosition(maker, '1', 'YES', successful(0n));
    reader.setPosition(maker, '1', 'NO', successful(0n));
    reader.setCollateral(maker, successful(3_000_000n));

    const result = await reconcileIndexedBalances(testPrisma, reader);

    expect(result.scopedCollateralAccounts).toBe(1);
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        account: maker,
        asset: 'COLLATERAL',
        action: 'created',
        chainRaw: '3000000',
      }),
    );
    expect(
      await testPrisma.collateralBalance.findUniqueOrThrow({
        where: { owner: maker },
      }),
    ).toMatchObject({
      balanceRaw: '3000000',
      blockNumber: 100,
      logIndex: 2_147_483_647,
    });
  });

  it('restores a missing NO sell order to the hybrid book through fillability', async () => {
    await testPrisma.bookMigration.create({
      data: {
        marketId: '1',
        status: 'MIGRATED',
        yesSeedOrderId: '2',
        noSeedOrderId: '3',
        createdAt: BOOK_NOW,
        updatedAt: BOOK_NOW,
        migratedAt: BOOK_NOW,
      },
    });
    const orderReader = new FakeOrderChainReader();
    const service = new OffchainOrderService(
      testPrisma,
      orderReader,
      new ServerEventBus(),
      () => BOOK_NOW,
    );
    const created = await signedOrderRequest({
      tokenId: 102n,
      side: Side.SELL,
      priceRaw: 482_000n,
      sizeRaw: 900_000n,
      salt: 702n,
    });
    orderReader.state = validChainState({
      complementTokenId: 101n,
      makerAssetBalance: 900_000n,
    });
    await service.ingest(created.request);
    const maker = created.account.address.toLowerCase();

    expect((await getMarketBook(testPrisma, '1'))?.no.offchainOrders).toEqual([]);

    const reader = new FakeBalanceReader();
    reader.setPosition(maker, '1', 'YES', successful(1_000_000n));
    reader.setPosition(maker, '1', 'NO', successful(900_000n));
    const reconciliation = await reconcileIndexedBalances(testPrisma, reader);

    expect(reconciliation.changes).toContainEqual(
      expect.objectContaining({ asset: 'NO', action: 'created', chainRaw: '900000' }),
    );
    expect(
      (await getMarketBook(testPrisma, '1'))?.no.offchainOrders.map(
        (order) => order.orderHash,
      ),
    ).toContain(created.request.orderHash.toLowerCase());
  });

  it('does not double-apply a gap transfer during an explicit replay', async () => {
    await createYesPosition('550000');
    const reader = new FakeBalanceReader();
    reader.setPosition(TRADER, '1', 'YES', successful(1_000_000n));
    reader.setPosition(TRADER, '1', 'NO', successful(0n));
    await reconcileIndexedBalances(testPrisma, reader);

    const transfer = (blockNumber: number, value: bigint): DecodedEvent => ({
      source: 'CTF',
      address: ADDRESSES.ctf,
      eventName: 'TransferSingle',
      args: {
        operator: TRADER,
        from: TRADER,
        to: '0x0000000000000000000000000000000000000000',
        id: 101n,
        value,
      },
      txHash: `${TRADE_TX.slice(0, -4)}${blockNumber
        .toString(16)
        .padStart(4, '0')}` as `0x${string}`,
      logIndex: 0,
      blockNumber,
      ts: BOOK_NOW + blockNumber,
    });

    await applyDecodedEvents(testPrisma, [transfer(99, 450_000n)], 99, 100);
    expect(
      (await testPrisma.position.findUniqueOrThrow({
        where: {
          account_marketId_outcome: {
            account: TRADER,
            marketId: '1',
            outcome: 'YES',
          },
        },
      })).qtyRaw,
    ).toBe('1000000');

    await applyDecodedEvents(testPrisma, [transfer(101, 100_000n)], 101, 101);
    expect(
      (await testPrisma.position.findUniqueOrThrow({
        where: {
          account_marketId_outcome: {
            account: TRADER,
            marketId: '1',
            outcome: 'YES',
          },
        },
      })).qtyRaw,
    ).toBe('900000');
  });

  it('discards a stale snapshot and retries if the indexer cursor advances', async () => {
    await createYesPosition('550000');
    const snapshots: number[] = [];
    const reader: BalanceChainReader = {
      async readBalances(input) {
        snapshots.push(input.blockNumber);
        if (snapshots.length === 1) {
          await testPrisma.indexerState.update({
            where: { id: 1 },
            data: { lastBlock: 101, headBlock: 101 },
          });
        }
        const yesBalance = input.blockNumber === 100 ? 1_000_000n : 1_100_000n;
        return {
          positions: input.positions.map((target) => ({
            ...target,
            result: successful(target.outcome === 'YES' ? yesBalance : 0n),
          })),
          collateral: [],
          rpcRequestCount: 1,
        };
      },
    };

    const result = await reconcileIndexedBalances(testPrisma, reader);

    expect(snapshots).toEqual([100, 101]);
    expect(result.snapshotBlock).toBe(101);
    expect(
      await testPrisma.position.findUniqueOrThrow({
        where: {
          account_marketId_outcome: {
            account: TRADER,
            marketId: '1',
            outcome: 'YES',
          },
        },
      }),
    ).toMatchObject({
      qtyRaw: '1100000',
      balanceReconciledBlock: 101,
    });
  });
});
