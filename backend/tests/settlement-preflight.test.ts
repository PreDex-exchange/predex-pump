import type { PublicClient } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerEventBus } from '../src/events/bus.js';
import {
  findCrossingCandidates,
  type ReservedMatch,
} from '../src/orderbook/matcher.js';
import { ViemSettlementPreflight } from '../src/orderbook/preflight.js';
import { OffchainOrderService } from '../src/orderbook/service.js';
import { resetDatabase, testPrisma } from './database.js';
import { MARKET_ONE_CONDITION, seedContractData } from './fixtures.js';
import {
  BOOK_NOW,
  FakeOrderChainReader,
  signedOrderRequest,
  validChainState,
} from './orderbook-fixtures.js';
import { Side } from '@predex-pump/shared/tx';

describe('block-pinned settlement preflight', () => {
  const ingestReader = new FakeOrderChainReader();
  const service = new OffchainOrderService(
    testPrisma,
    ingestReader,
    new ServerEventBus(),
    () => BOOK_NOW,
  );

  beforeEach(async () => {
    await resetDatabase();
    await seedContractData();
  });

  async function crossingMatch(): Promise<ReservedMatch> {
    const buy = await signedOrderRequest({
      side: Side.BUY,
      priceRaw: 700_000n,
      salt: 401n,
    });
    ingestReader.state = validChainState({
      approvalKind: 'COLLATERAL_ALLOWANCE',
      collateralAllowance: 10_000_000n,
      ctfApprovedForAll: null,
    });
    await service.ingest(buy.request);
    const sell = await signedOrderRequest({
      side: Side.SELL,
      priceRaw: 650_000n,
      salt: 402n,
    });
    ingestReader.state = validChainState();
    await service.ingest(sell.request);
    await testPrisma.position.create({
      data: {
        account: sell.account.address.toLowerCase(),
        marketId: '1',
        outcome: 'YES',
        qtyRaw: '10000000',
        updatedAt: BOOK_NOW,
      },
    });
    const candidate = findCrossingCandidates(
      await testPrisma.signedOrder.findMany(),
    )[0];
    if (candidate === undefined) throw new Error('Expected crossing test orders');
    return { ...candidate, id: candidate.matchKey };
  }

  function valuesFor(match: ReservedMatch, payoutDenominator = 0n) {
    return [match.takerOrder, match.makerOrder].flatMap((order) => [
      7n,
      [102n, MARKET_ONE_CONDITION, 2_000_086_400n],
      payoutDenominator,
      false,
      BigInt(order.filledRaw),
      10_000_000n,
      order.exchangeSide === Side.BUY ? 10_000_000n : true,
    ]);
  }

  it('checks resolution, nonce, cancellation, fill state, balance, and approval in one multicall', async () => {
    const match = await crossingMatch();
    const multicall = vi.fn(async (_parameters: unknown) => valuesFor(match));
    const client = {
      getBlock: vi.fn(async () => ({ number: 999n, timestamp: BigInt(BOOK_NOW) })),
      multicall,
    } as unknown as PublicClient;

    await expect(new ViemSettlementPreflight(client).check(match)).resolves.toEqual({
      ok: true,
      blockNumber: 999,
    });
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(multicall.mock.calls[0]?.[0]).toMatchObject({
      allowFailure: false,
      blockNumber: 999n,
      contracts: expect.arrayContaining([
        expect.objectContaining({ functionName: 'payoutDenominator' }),
        expect.objectContaining({ functionName: 'makerNonce' }),
        expect.objectContaining({ functionName: 'cancelledOrders' }),
        expect.objectContaining({ functionName: 'filledAmount' }),
        expect.objectContaining({ functionName: 'balanceOf' }),
      ]),
    });
  });

  it('rejects when the fresh payout denominator becomes non-zero', async () => {
    const match = await crossingMatch();
    const client = {
      getBlock: vi.fn(async () => ({ number: 1_000n, timestamp: BigInt(BOOK_NOW) })),
      multicall: vi.fn(async () => valuesFor(match, 1n)),
    } as unknown as PublicClient;

    await expect(new ViemSettlementPreflight(client).check(match)).resolves.toMatchObject({
      ok: false,
      code: 'MARKET_RESOLVED',
      blockNumber: 1_000,
    });
  });

  it('rejects at the registered global deadline before submitting a fill', async () => {
    const match = await crossingMatch();
    const client = {
      getBlock: vi.fn(async () => ({
        number: 1_001n,
        timestamp: 2_000_086_400n,
      })),
      multicall: vi.fn(async () => valuesFor(match)),
    } as unknown as PublicClient;

    await expect(new ViemSettlementPreflight(client).check(match)).resolves.toMatchObject({
      ok: false,
      code: 'TRADING_ENDED',
      blockNumber: 1_001,
    });
  });

  it('reports resolution before deadline closure when both are terminal', async () => {
    const match = await crossingMatch();
    const client = {
      getBlock: vi.fn(async () => ({
        number: 1_002n,
        timestamp: 2_000_086_400n,
      })),
      multicall: vi.fn(async () => valuesFor(match, 1n)),
    } as unknown as PublicClient;

    await expect(new ViemSettlementPreflight(client).check(match)).resolves.toMatchObject({
      ok: false,
      code: 'MARKET_RESOLVED',
      blockNumber: 1_002,
    });
  });
});
