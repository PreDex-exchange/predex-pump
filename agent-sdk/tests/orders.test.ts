import type {
  IngestOrderRequest,
  MakerOrdersResponse,
  SiweNonceResponse,
  WithdrawOrderResponse,
} from '@predex-pump/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  createRestClient,
  OrderIngestRejectedError,
} from '../src/index.js';

const ORDER_HASH = `0x${'12'.repeat(32)}` as const;
const SESSION_COOKIE = 'predex_session=session-token';

const request: IngestOrderRequest = {
  orderHash: ORDER_HASH,
  order: {
    saltRaw: '1',
    maker: `0x${'34'.repeat(20)}`,
    signer: `0x${'34'.repeat(20)}`,
    taker: `0x${'00'.repeat(20)}`,
    tokenId: '101',
    makerAmountRaw: '500000',
    takerAmountRaw: '1000000',
    expiration: 2_000_000_000,
    nonceRaw: '7',
    feeRateBpsRaw: '0',
    side: 0,
    signatureType: 0,
    signature: `0x${'56'.repeat(65)}`,
  },
};

const makerOrders: MakerOrdersResponse = {
  orders: [],
  onchainOrders: [],
  offchainWithdrawalIsOnchainCancellation: false,
  warning: 'Off-chain withdrawal does not cancel on-chain.',
};

const withdrawal = {
  order: {
    orderHash: ORDER_HASH,
  },
  offchainWithdrawalIsOnchainCancellation: false,
  signedOrderMayRemainValidOnchain: true,
  warning: 'Signature remains valid.',
  authoritativeCancelOrderTx: {
    to: `0x${'78'.repeat(20)}`,
    data: '0x1234',
    valueRaw: '0',
  },
} as unknown as WithdrawOrderResponse;

describe('PredexRestClient Hybrid order methods', () => {
  it('posts a signed order without attaching a session cookie', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ order: withdrawal.order }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createRestClient({
      baseUrl: 'http://predex.test/',
      fetch: fetchMock,
    });

    await client.postOrder(request);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://predex.test/orders',
      expect.objectContaining({
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      }),
    );
  });

  it('carries the caller session cookie when listing and withdrawing maker orders', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makerOrders), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(withdrawal), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = createRestClient({
      baseUrl: 'http://predex.test',
      fetch: fetchMock,
    });

    await expect(client.getMyOrders(SESSION_COOKIE)).resolves.toEqual(
      makerOrders,
    );
    await expect(
      client.withdrawOrder(ORDER_HASH, SESSION_COOKIE),
    ).resolves.toEqual(withdrawal);

    expect(fetchMock.mock.calls[0]).toEqual([
      'http://predex.test/orders',
      expect.objectContaining({
        headers: { accept: 'application/json', cookie: SESSION_COOKIE },
      }),
    ]);
    expect(fetchMock.mock.calls[1]).toEqual([
      `http://predex.test/orders/${ORDER_HASH}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { accept: 'application/json', cookie: SESSION_COOKIE },
      }),
    ]);
  });

  it('preserves the typed ingest rejection code', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'WRONG_NONCE',
            message: 'makerNonce changed',
          },
        }),
        {
          status: 422,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const client = createRestClient({ fetch: fetchMock });

    const error = await client.postOrder(request).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(OrderIngestRejectedError);
    expect(error).toMatchObject({
      status: 422,
      code: 'WRONG_NONCE',
      message: 'makerNonce changed',
    });
  });

  it('decodes TRADING_ENDED as a typed ingest rejection', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'TRADING_ENDED',
            message: 'global trading deadline reached',
          },
        }),
        {
          status: 422,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const client = createRestClient({ fetch: fetchMock });

    const error = await client.postOrder(request).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(OrderIngestRejectedError);
    expect(error).toMatchObject({
      status: 422,
      code: 'TRADING_ENDED',
      message: 'global trading deadline reached',
    });
  });
});

describe('PredexRestClient SIWE methods', () => {
  it('returns the HttpOnly session cookie from verification for headless callers', async () => {
    const nonce: SiweNonceResponse = {
      nonce: 'abcdefgh',
      domain: 'predex.test',
      uri: 'https://predex.test',
      chainId: 5_042_002,
      statement: 'Sign in.',
      issuedAt: '2030-01-01T00:00:00.000Z',
      expirationTime: '2030-01-01T00:05:00.000Z',
    };
    const session = {
      authenticated: true as const,
      address: `0x${'34'.repeat(20)}` as const,
      expiresAt: '2030-01-08T00:00:00.000Z',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(nonce), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(session), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax`,
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = createRestClient({ fetch: fetchMock });

    await expect(client.getSiweNonce()).resolves.toEqual(nonce);
    await expect(
      client.verifySiwe({ message: 'message', signature: '0x1234' }),
    ).resolves.toEqual({ session, sessionCookie: SESSION_COOKIE });
    await expect(client.getSession(SESSION_COOKIE)).resolves.toEqual(session);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        headers: { accept: 'application/json', cookie: SESSION_COOKIE },
      }),
    );
  });
});
