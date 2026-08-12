import { createHash } from 'node:crypto';

import type {
  IngestOrderResponse,
  MakerOrdersResponse,
  OrderIngestRejection,
  WithdrawOrderResponse,
} from '@predex-pump/shared';
import {
  hashCtfExchangeOrder,
  signCtfExchangeOrder,
} from '@predex-pump/shared/tx';
import type { FastifyInstance } from 'fastify';
import { zeroHash } from 'viem';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { SESSION_COOKIE_NAME } from '../src/account/service.js';
import { ServerEventBus } from '../src/events/bus.js';
import { resetDatabase, testPrisma } from './database.js';
import { seedContractData } from './fixtures.js';
import {
  BOOK_NOW,
  FakeOrderChainReader,
  orderWire,
  signedOrderRequest,
  throwawayAccount,
  validChainState,
} from './orderbook-fixtures.js';

describe('POST /orders validation', () => {
  let app: FastifyInstance;
  const reader = new FakeOrderChainReader();

  beforeAll(async () => {
    app = await buildServer({
      prisma: testPrisma,
      eventBus: new ServerEventBus(),
      orderChainReader: reader,
      orderNow: () => BOOK_NOW,
      logger: false,
    });
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedContractData();
    reader.state = validChainState();
    reader.calls = 0;
  });

  afterAll(async () => {
    await app.close();
    await testPrisma.$disconnect();
  });

  async function submit(payload: object) {
    return await app.inject({ method: 'POST', url: '/orders', payload });
  }

  async function expectReason(
    payload: object,
    code: OrderIngestRejection['error']['code'],
  ): Promise<void> {
    const response = await submit(payload);
    expect(response.statusCode).toBe(422);
    expect(response.json<OrderIngestRejection>().error).toMatchObject({ code });
  }

  it('accepts and persists a well-formed EOA signed order', async () => {
    const { request, account } = await signedOrderRequest({ salt: 1n });
    const response = await submit(request);

    expect(response.statusCode).toBe(200);
    expect(response.json<IngestOrderResponse>().order).toMatchObject({
      orderHash: request.orderHash.toLowerCase(),
      maker: account.address.toLowerCase(),
      marketId: '1',
      outcome: 'YES',
      side: 'ASK',
      priceRaw: '650000',
      sizeRaw: '1000000',
      remainingRaw: '1000000',
      status: 'OPEN',
    });
    expect(await testPrisma.signedOrder.findUnique({
      where: { orderHash: request.orderHash.toLowerCase() },
    })).toMatchObject({ signature: request.order.signature });
    expect(reader.calls).toBe(1);
  });

  it('rejects an order hash that does not match P1 hashing', async () => {
    const { request } = await signedOrderRequest({ salt: 2n });
    await expectReason({ ...request, orderHash: zeroHash }, 'ORDER_HASH_MISMATCH');
  });

  it('rejects a bad signature with BAD_SIGNATURE', async () => {
    const { request } = await signedOrderRequest({ salt: 3n });
    await expectReason(
      { ...request, order: { ...request.order, signature: '0xdeadbeef' } },
      'BAD_SIGNATURE',
    );
  });

  it('rejects a valid but unauthorised EOA signer', async () => {
    const maker = throwawayAccount();
    const signer = throwawayAccount();
    const { request } = await signedOrderRequest({
      maker: maker.address,
      signerAccount: signer,
      salt: 4n,
    });
    await expectReason(request, 'SIGNER_UNAUTHORIZED');
  });

  it('rejects a wrong maker nonce with WRONG_NONCE', async () => {
    const { request } = await signedOrderRequest({ salt: 5n });
    reader.state = validChainState({ makerNonce: 8n });
    await expectReason(request, 'WRONG_NONCE');
  });

  it('rejects an expired order with EXPIRED', async () => {
    const { request } = await signedOrderRequest({
      expiration: BigInt(BOOK_NOW - 1),
      salt: 6n,
    });
    await expectReason(request, 'EXPIRED');
  });

  it('rejects an unregistered token with TOKEN_NOT_REGISTERED', async () => {
    const { request } = await signedOrderRequest({ salt: 7n });
    reader.state = validChainState({
      complementTokenId: 0n,
      registeredConditionId: zeroHash,
    });
    await expectReason(request, 'TOKEN_NOT_REGISTERED');
  });

  it('rejects the real indexed resolved-market fixture with MARKET_RESOLVED', async () => {
    const { request } = await signedOrderRequest({ tokenId: 201n, salt: 8n });
    await expectReason(request, 'MARKET_RESOLVED');
    expect(reader.calls).toBe(0);
  });

  it('rejects a fresh on-chain resolution with MARKET_RESOLVED', async () => {
    const { request } = await signedOrderRequest({ salt: 9n });
    reader.state = validChainState({ payoutDenominator: 1n });
    await expectReason(request, 'MARKET_RESOLVED');
  });

  it('rejects insufficient maker balance with INSUFFICIENT_BALANCE', async () => {
    const { request } = await signedOrderRequest({ salt: 10n });
    reader.state = validChainState({ makerAssetBalance: 999_999n });
    await expectReason(request, 'INSUFFICIENT_BALANCE');
  });

  it('rejects a missing exchange approval with MISSING_APPROVAL', async () => {
    const { request } = await signedOrderRequest({ salt: 11n });
    reader.state = validChainState({ ctfApprovedForAll: false });
    await expectReason(request, 'MISSING_APPROVAL');
  });

  it('rejects zero size and an above-par price with distinct reasons', async () => {
    const base = await signedOrderRequest({ salt: 12n });
    const zeroSize = await signCtfExchangeOrder(base.account, {
      ...base.order,
      makerAmount: 0n,
      signature: '0x',
    });
    await expectReason(
      {
        orderHash: hashCtfExchangeOrder(zeroSize),
        order: orderWire(zeroSize),
      },
      'INVALID_SIZE',
    );

    const abovePar = await signedOrderRequest({
      priceRaw: 1_000_001n,
      salt: 13n,
    });
    await expectReason(abovePar.request, 'INVALID_PRICE');
  });

  it('accepts an on-tick price and rejects an off-tick price with PRICE_NOT_ON_TICK', async () => {
    const onTick = await signedOrderRequest({
      priceRaw: 517_000n,
      sizeRaw: 123_000n,
      salt: 131n,
    });
    expect((await submit(onTick.request)).statusCode).toBe(200);

    const offTick = await signedOrderRequest({
      priceRaw: 517_001n,
      sizeRaw: 1_000_000n,
      salt: 132n,
    });
    await expectReason(offTick.request, 'PRICE_NOT_ON_TICK');
  });

  it('rejects a size that could leave an unrepresentable partial-fill remainder', async () => {
    const awkward = await signedOrderRequest({
      priceRaw: 517_000n,
      sizeRaw: 450_123n,
      salt: 133n,
    });
    await expectReason(awkward.request, 'INVALID_SIZE');
  });

  it('serves the authenticated maker orders and protects local withdrawal', async () => {
    const { request, account } = await signedOrderRequest({ salt: 14n });
    expect((await submit(request)).statusCode).toBe(200);
    await testPrisma.order.create({
      data: {
        orderId: '900',
        marketId: '1',
        conditionId: `0x${'1'.repeat(64)}`,
        tokenId: '101',
        outcome: 'YES',
        maker: account.address.toLowerCase(),
        side: 'ASK',
        priceRaw: '650000',
        sizeRaw: '1000000',
        escrowRaw: '1000000',
        filledRaw: '0',
        remainingRaw: '1000000',
        open: true,
        isSeed: false,
        txHash: `0x${'9'.repeat(64)}`,
        logIndex: 9,
        blockNumber: 99,
        createdAt: BOOK_NOW,
        updatedAt: BOOK_NOW,
      },
    });
    const token = 'throwaway-test-session';
    await testPrisma.userAccount.create({
      data: { address: account.address.toLowerCase() },
    });
    await testPrisma.authSession.create({
      data: {
        tokenHash: createHash('sha256').update(token).digest('hex'),
        accountAddress: account.address.toLowerCase(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;

    const own = await app.inject({
      method: 'GET',
      url: '/orders',
      headers: { cookie },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json<MakerOrdersResponse>()).toMatchObject({
      offchainWithdrawalIsOnchainCancellation: false,
      orders: [{ orderHash: request.orderHash.toLowerCase() }],
      onchainOrders: [{ orderId: '900', maker: account.address.toLowerCase() }],
    });

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/orders/${request.orderHash}`,
        })
      ).statusCode,
    ).toBe(401);
    const withdrawn = await app.inject({
      method: 'DELETE',
      url: `/orders/${request.orderHash}`,
      headers: { cookie },
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json<WithdrawOrderResponse>()).toMatchObject({
      offchainWithdrawalIsOnchainCancellation: false,
      signedOrderMayRemainValidOnchain: true,
      order: { status: 'WITHDRAWN' },
    });
    await expectReason(request, 'ORDER_ALREADY_WITHDRAWN');
  });
});
