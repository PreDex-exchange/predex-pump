import { Side } from '@predex-pump/shared/tx';
import type { Hex } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerEventBus } from '../src/events/bus.js';
import {
  findCrossingCandidates,
} from '../src/orderbook/matcher.js';
import {
  SettlementOperator,
  type OperatorLogger,
  type SettlementSubmitter,
} from '../src/orderbook/operator.js';
import type {
  SettlementPreflight,
  SettlementPreflightResult,
} from '../src/orderbook/preflight.js';
import { OffchainOrderService } from '../src/orderbook/service.js';
import { resetDatabase, testPrisma } from './database.js';
import { seedContractData } from './fixtures.js';
import {
  BOOK_NOW,
  FakeOrderChainReader,
  signedOrderRequest,
  validChainState,
} from './orderbook-fixtures.js';

class FakePreflight implements SettlementPreflight {
  calls = 0;
  result: SettlementPreflightResult = { ok: true, blockNumber: 999 };

  async check(): Promise<SettlementPreflightResult> {
    this.calls += 1;
    return this.result;
  }
}

describe('matcher and settlement operator', () => {
  const reader = new FakeOrderChainReader();
  const orderService = new OffchainOrderService(
    testPrisma,
    reader,
    new ServerEventBus(),
    () => BOOK_NOW,
  );

  beforeEach(async () => {
    await resetDatabase();
    await seedContractData();
    reader.state = validChainState();
  });

  async function createOrder(input: {
    tokenId?: bigint;
    side: 0 | 1;
    priceRaw: bigint;
    sizeRaw?: bigint;
    salt: bigint;
  }) {
    const tokenId = input.tokenId ?? 101n;
    const created = await signedOrderRequest({
      tokenId,
      side: input.side,
      priceRaw: input.priceRaw,
      sizeRaw: input.sizeRaw ?? 1_000_000n,
      salt: input.salt,
    });
    reader.state = validChainState({
      complementTokenId: tokenId === 101n ? 102n : 101n,
      ...(input.side === Side.BUY
        ? {
            approvalKind: 'COLLATERAL_ALLOWANCE' as const,
            collateralAllowance: 10_000_000n,
            ctfApprovedForAll: null,
          }
        : {}),
    });
    await orderService.ingest(created.request);
    if (input.side === Side.SELL) {
      await testPrisma.position.create({
        data: {
          account: created.account.address.toLowerCase(),
          marketId: '1',
          outcome: tokenId === 101n ? 'YES' : 'NO',
          qtyRaw: '10000000',
          updatedAt: BOOK_NOW,
        },
      });
    }
    return created;
  }

  it('finds crossing orders and ignores non-crossing prices', async () => {
    await createOrder({ side: Side.BUY, priceRaw: 700_000n, salt: 301n });
    await createOrder({ side: Side.SELL, priceRaw: 650_000n, salt: 302n });
    const crossing = findCrossingCandidates(await testPrisma.signedOrder.findMany());
    expect(crossing).toHaveLength(1);
    expect(crossing[0]).toMatchObject({
      fillSizeRaw: '1000000',
    });

    await resetDatabase();
    await seedContractData();
    await createOrder({ side: Side.BUY, priceRaw: 600_000n, salt: 303n });
    await createOrder({ side: Side.SELL, priceRaw: 650_000n, salt: 304n });
    expect(findCrossingCandidates(await testPrisma.signedOrder.findMany())).toEqual([]);
  });

  it('fresh preflight blocks submission when the market resolved after ingest', async () => {
    await createOrder({ side: Side.BUY, priceRaw: 700_000n, salt: 305n });
    await createOrder({ side: Side.SELL, priceRaw: 650_000n, salt: 306n });
    const preflight = new FakePreflight();
    preflight.result = {
      ok: false,
      code: 'MARKET_RESOLVED',
      message: 'Market resolved at the fresh pre-submit block',
      blockNumber: 1_000,
    };
    const submit = vi.fn<SettlementSubmitter['submit']>();
    const operator = new SettlementOperator(
      testPrisma,
      preflight,
      { submit },
      { info: vi.fn(), warn: vi.fn() },
      () => BOOK_NOW,
    );

    await expect(operator.processOnce()).resolves.toMatchObject({
      outcome: 'BLOCKED',
    });
    expect(preflight.calls).toBe(1);
    expect(submit).not.toHaveBeenCalled();
    expect(await testPrisma.settlementMatch.findFirst()).toMatchObject({
      status: 'BLOCKED',
      failureCode: 'MARKET_RESOLVED',
    });
    expect(
      await testPrisma.signedOrder.findMany({ select: { status: true } }),
    ).toEqual([{ status: 'MARKET_RESOLVED' }, { status: 'MARKET_RESOLVED' }]);
  });

  it('claims durably before send so a restart cannot submit the same match twice', async () => {
    await createOrder({ side: Side.BUY, priceRaw: 700_000n, salt: 307n });
    await createOrder({ side: Side.SELL, priceRaw: 650_000n, salt: 308n });
    const preflight = new FakePreflight();
    const submit = vi.fn<SettlementSubmitter['submit']>().mockResolvedValue(
      `0x${'a'.repeat(64)}` as Hex,
    );
    const logger = { info: vi.fn(), warn: vi.fn() };
    const firstProcess = new SettlementOperator(
      testPrisma,
      preflight,
      { submit },
      logger,
      () => BOOK_NOW,
    );
    const restartedProcess = new SettlementOperator(
      testPrisma,
      preflight,
      { submit },
      logger,
      () => BOOK_NOW + 1,
    );

    await expect(firstProcess.processOnce()).resolves.toMatchObject({
      outcome: 'SUBMITTED',
    });
    await expect(restartedProcess.processOnce()).resolves.toEqual({ outcome: 'IDLE' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await testPrisma.settlementMatch.findFirst()).toMatchObject({
      status: 'SUBMITTED',
      attemptCount: 1,
    });
  });

  it('records a submit failure, redacts secrets from logs, and continues to another match', async () => {
    const yesBid = await createOrder({
      tokenId: 101n,
      side: Side.BUY,
      priceRaw: 700_000n,
      salt: 309n,
    });
    await createOrder({
      tokenId: 101n,
      side: Side.SELL,
      priceRaw: 650_000n,
      salt: 310n,
    });
    await createOrder({
      tokenId: 102n,
      side: Side.BUY,
      priceRaw: 600_000n,
      salt: 311n,
    });
    await createOrder({
      tokenId: 102n,
      side: Side.SELL,
      priceRaw: 550_000n,
      salt: 312n,
    });

    const keyMaterial = `0x${'1'.repeat(64)}`;
    const submit = vi
      .fn<SettlementSubmitter['submit']>()
      .mockRejectedValueOnce(
        new Error(
          `rpc failed key=${keyMaterial} signature=${yesBid.request.order.signature}`,
        ),
      )
      .mockResolvedValueOnce(`0x${'b'.repeat(64)}` as Hex);
    const messages: string[] = [];
    const logger: OperatorLogger = {
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    };
    const operator = new SettlementOperator(
      testPrisma,
      new FakePreflight(),
      { submit },
      logger,
      () => BOOK_NOW,
    );

    await expect(operator.processOnce()).resolves.toMatchObject({ outcome: 'FAILED' });
    await expect(operator.processOnce()).resolves.toMatchObject({ outcome: 'SUBMITTED' });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(
      (await testPrisma.settlementMatch.findMany({ orderBy: { createdAt: 'asc' } }))
        .map((match) => match.status)
        .sort(),
    ).toEqual(['FAILED', 'SUBMITTED']);
    const output = messages.join('\n');
    expect(output).not.toContain(keyMaterial);
    expect(output).not.toContain(yesBid.request.order.signature);
  });

  it('quarantines an unknown RPC submission outcome instead of risking a resend', async () => {
    await createOrder({ side: Side.BUY, priceRaw: 700_000n, salt: 313n });
    await createOrder({ side: Side.SELL, priceRaw: 650_000n, salt: 314n });
    const submit = vi
      .fn<SettlementSubmitter['submit']>()
      .mockRejectedValue(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      );
    const operator = new SettlementOperator(
      testPrisma,
      new FakePreflight(),
      { submit },
      { info: vi.fn(), warn: vi.fn() },
      () => BOOK_NOW,
    );

    await expect(operator.processOnce()).resolves.toMatchObject({
      outcome: 'FAILED',
      failureCode: 'RPC_TRANSIENT',
    });
    expect(await testPrisma.settlementMatch.findFirst()).toMatchObject({
      status: 'SUBMISSION_UNKNOWN',
      failureCode: 'RPC_TRANSIENT',
      txHash: null,
    });
    await expect(operator.processOnce()).resolves.toEqual({ outcome: 'IDLE' });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
