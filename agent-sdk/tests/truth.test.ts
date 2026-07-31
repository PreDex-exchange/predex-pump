import { ADDRESSES, type TruthSignalResponse } from '@predex-pump/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  createCircleX402PaymentProvider,
  createTruthClient,
  type CircleX402Signer,
  TruthPaymentUnavailableError,
  type X402BuyerPaymentProvider,
} from '../src/index.js';

const SIGNAL = {
  marketId: '1',
  estimateType: 'INDEXED_MARKET_ESTIMATE',
  fairValueYesRaw: '614166',
  fairValueNoRaw: '385834',
} as TruthSignalResponse;
const REQUIREMENTS = {
  scheme: 'exact',
  network: 'eip155:5042002',
  asset: ADDRESSES.usdc,
  amount: '100',
  payTo: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  maxTimeoutSeconds: 604_900,
  extra: {
    name: 'GatewayWalletBatched',
    version: '1',
    verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
  },
};

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function decoded(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as unknown;
}

function paymentRequired(amount = '100'): Response {
  return new Response(JSON.stringify({ error: 'payment required' }), {
    status: 402,
    headers: {
      'content-type': 'application/json',
      'PAYMENT-REQUIRED': encoded({
        x402Version: 2,
        resource: {
          url: '/truth/1',
          description: 'Truth signal',
          mimeType: 'application/json',
        },
        accepts: [{ ...REQUIREMENTS, amount }],
      }),
    },
  });
}

function provider(): X402BuyerPaymentProvider & {
  createPaymentPayload: ReturnType<
    typeof vi.fn<X402BuyerPaymentProvider['createPaymentPayload']>
  >;
} {
  return {
    createPaymentPayload: vi.fn(async () => ({
      x402Version: 2,
      payload: { authorization: { signature: 'mocked' } },
    })),
  };
}

describe('truth.buy Circle x402 buyer', () => {
  it('uses Circle BatchEvmScheme to sign a fundless EIP-3009 payload', async () => {
    const signTypedData = vi.fn(async () =>
      `0x${'1'.repeat(130)}` as `0x${string}`,
    );
    const paymentProvider = createCircleX402PaymentProvider({
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      signTypedData,
    } satisfies CircleX402Signer);

    const payload = await paymentProvider.createPaymentPayload(2, REQUIREMENTS);

    expect(signTypedData).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({
      x402Version: 2,
      payload: {
        authorization: {
          from: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          to: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa',
          value: REQUIREMENTS.amount,
        },
        signature: `0x${'1'.repeat(130)}`,
      },
    });
  });

  it('attaches the signed PAYMENT-SIGNATURE and returns the paid signal', async () => {
    const paymentProvider = provider();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(paymentRequired())
      .mockResolvedValueOnce(
        new Response(JSON.stringify(SIGNAL), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'PAYMENT-RESPONSE': encoded({
              success: true,
              transaction: 'batch-transfer-id',
              network: REQUIREMENTS.network,
              payer: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            }),
          },
        }),
      );
    const client = createTruthClient({
      baseUrl: 'http://predex.test/',
      fetch: fetchMock,
      paymentProvider,
    });

    const result = await client.buy({
      marketId: '1',
      payment: {
        asset: ADDRESSES.usdc,
        network: REQUIREMENTS.network,
        maxAmountRaw: 100n,
      },
    });

    expect(paymentProvider.createPaymentPayload).toHaveBeenCalledWith(
      2,
      REQUIREMENTS,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://predex.test/truth/1');
    const paidHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(decoded(paidHeaders['Payment-Signature'] ?? '')).toEqual({
      x402Version: 2,
      payload: { authorization: { signature: 'mocked' } },
      resource: {
        url: '/truth/1',
        description: 'Truth signal',
        mimeType: 'application/json',
      },
      accepted: REQUIREMENTS,
    });
    expect(result).toEqual({
      signal: SIGNAL,
      sourceUrl: 'http://predex.test/truth/1',
      paymentReceipt: {
        paid: true,
        amountRaw: 100n,
        asset: ADDRESSES.usdc,
        network: REQUIREMENTS.network,
        transaction: 'batch-transfer-id',
        payer: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    });
  });

  it('refuses an above-limit price before asking the provider to sign', async () => {
    const paymentProvider = provider();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(paymentRequired('101'));
    const client = createTruthClient({
      fetch: fetchMock,
      paymentProvider,
    });

    await expect(
      client.buy({
        marketId: '1',
        payment: {
          asset: ADDRESSES.usdc,
          network: REQUIREMENTS.network,
          maxAmountRaw: 100n,
        },
      }),
    ).rejects.toThrow(/exceeds configured maximum/u);
    expect(paymentProvider.createPaymentPayload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports a clear unavailable error when a paid endpoint has no provider', async () => {
    const client = createTruthClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(paymentRequired()),
    });

    await expect(
      client.buy({
        marketId: '1',
        payment: {
          asset: ADDRESSES.usdc,
          maxAmountRaw: 100n,
        },
      }),
    ).rejects.toBeInstanceOf(TruthPaymentUnavailableError);
  });

  it('degrades to the unpaid Stage 1 response without signing in dev mode', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(SIGNAL), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = createTruthClient({ fetch: fetchMock });

    const result = await client.buy({
      marketId: '1',
      payment: { asset: ADDRESSES.usdc, maxAmountRaw: 100n },
    });

    expect(result.paymentReceipt).toEqual({ paid: false, amountRaw: 0n });
    expect(result.signal).toEqual(SIGNAL);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
