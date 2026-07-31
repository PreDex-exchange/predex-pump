import { BatchEvmScheme } from '@circle-fin/x402-batching/client';
import type { TruthSignalResponse } from '@predex-pump/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/api/server.js';
import {
  CircleTruthPaymentGate,
  type CircleFacilitator,
} from '../src/truth-payment/circle-provider.js';
import {
  createTruthPaymentGate,
  loadTruthSellerConfig,
} from '../src/truth-payment/config.js';
import {
  decodePaymentHeader,
  encodePaymentHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type TruthPaymentRequired,
} from '../src/truth-payment/types.js';
import { ServerEventBus } from '../src/events/bus.js';
import { resetDatabase, testPrisma } from './database.js';
import { seedContractData } from './fixtures.js';

const SELLER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PAYER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TRANSACTION = `0x${'c'.repeat(64)}`;
const SIGNATURE = `0x${'1'.repeat(130)}` as `0x${string}`;

describe('Circle x402 truth seller', () => {
  let app: FastifyInstance;
  let gate: CircleTruthPaymentGate;
  const settle = vi.fn<CircleFacilitator['settle']>();
  const logInfo = vi.fn();
  const logWarn = vi.fn();

  beforeAll(async () => {
    gate = new CircleTruthPaymentGate({
      sellerAddress: SELLER,
      amountRaw: 100n,
      facilitator: { settle },
      logger: { info: logInfo, warn: logWarn },
    });
    app = await buildServer({
      prisma: testPrisma,
      eventBus: new ServerEventBus(),
      truthPaymentGate: gate,
      logger: false,
    });
  });

  beforeEach(async () => {
    settle.mockReset();
    logInfo.mockReset();
    logWarn.mockReset();
    settle.mockResolvedValue({
      success: true,
      payer: PAYER,
      transaction: TRANSACTION,
      network: 'eip155:5042002',
    });
    await resetDatabase();
    await seedContractData();
  });

  afterAll(async () => {
    await app.close();
    await testPrisma.$disconnect();
  });

  async function validPaymentPayload() {
    const paymentRequired = decodePaymentHeader(
      gate.paymentRequiredHeader('/truth/1'),
    ) as TruthPaymentRequired;
    const scheme = new BatchEvmScheme({
      address: PAYER,
      signTypedData: vi.fn(async () => SIGNATURE),
    });
    const signed = await scheme.createPaymentPayload(
      paymentRequired.x402Version,
      paymentRequired.accepts[0],
    );
    return {
      x402Version: signed.x402Version,
      resource: paymentRequired.resource,
      accepted: paymentRequired.accepts[0],
      payload: signed.payload,
    };
  }

  async function validPaymentHeader(): Promise<string> {
    return encodePaymentHeader(await validPaymentPayload());
  }

  it('returns 402 plus verified Arc Testnet Gateway requirements when unpaid', async () => {
    const response = await app.inject({ method: 'GET', url: '/truth/1' });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toEqual({
      error: 'Payment required for this truth signal.',
    });
    const encoded = response.headers[PAYMENT_REQUIRED_HEADER.toLowerCase()];
    expect(encoded).toEqual(expect.any(String));
    const paymentRequired = decodePaymentHeader(
      encoded as string,
    ) as TruthPaymentRequired;
    expect(paymentRequired).toEqual({
      x402Version: 2,
      resource: {
        url: '/truth/1',
        description: 'Predex indexed market-microstructure truth signal',
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:5042002',
          asset: '0x3600000000000000000000000000000000000000',
          amount: '100',
          payTo: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa',
          maxTimeoutSeconds: 604_900,
          extra: {
            name: 'GatewayWalletBatched',
            version: '1',
            verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
          },
        },
      ],
    });
    expect(settle).not.toHaveBeenCalled();
  });

  it('passes the full envelope around the real Circle SDK payload to settlement', async () => {
    const paymentPayload = await validPaymentPayload();
    expect(Object.keys(paymentPayload)).toEqual([
      'x402Version',
      'resource',
      'accepted',
      'payload',
    ]);
    expect(Object.keys(paymentPayload.payload)).toEqual([
      'authorization',
      'signature',
    ]);
    expect(Object.keys(paymentPayload.payload.authorization)).toEqual([
      'from',
      'to',
      'value',
      'validAfter',
      'validBefore',
      'nonce',
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentHeader(paymentPayload),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<TruthSignalResponse>().fairValueYesRaw).toBe('614166');
    expect(settle).toHaveBeenCalledWith(
      paymentPayload,
      gate.requirements,
    );
    expect(settle).toHaveBeenCalledOnce();
    expect(logInfo).toHaveBeenCalledWith(
      {
        success: true,
        errorReason: null,
        payer: PAYER,
        transaction: TRANSACTION,
      },
      'Circle truth payment settlement succeeded',
    );
    expect(logWarn).not.toHaveBeenCalled();
    const paymentResponse = decodePaymentHeader(
      response.headers[PAYMENT_RESPONSE_HEADER.toLowerCase()] as string,
    );
    expect(paymentResponse).toEqual({
      success: true,
      transaction: TRANSACTION,
      network: 'eip155:5042002',
      payer: PAYER,
    });
  });

  it('rejects the unenriched Circle SDK payload before settlement', async () => {
    const scheme = new BatchEvmScheme({
      address: PAYER,
      signTypedData: vi.fn(async () => SIGNATURE),
    });
    const signedCore = await scheme.createPaymentPayload(2, gate.requirements);

    const response = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentHeader(signedCore),
      },
    });

    expect(response.statusCode).toBe(402);
    expect(settle).not.toHaveBeenCalled();
  });

  it.each([
    ['amount', { amount: '0100' }],
    ['payTo', { payTo: '0xcccccccccccccccccccccccccccccccccccccccc' }],
  ])(
    'rejects an accepted entry with a mismatched %s before settlement',
    async (_field, change) => {
      const paymentPayload = await validPaymentPayload();
      const mismatched = {
        ...paymentPayload,
        accepted: { ...paymentPayload.accepted, ...change },
      };

      const response = await app.inject({
        method: 'GET',
        url: '/truth/1',
        headers: {
          [PAYMENT_SIGNATURE_HEADER]: encodePaymentHeader(mismatched),
        },
      });

      expect(response.statusCode).toBe(402);
      expect(settle).not.toHaveBeenCalled();
    },
  );

  it('compares accepted EVM addresses case-insensitively', async () => {
    const paymentPayload = await validPaymentPayload();
    const accepted = paymentPayload.accepted;
    const differentlyCased = {
      ...paymentPayload,
      accepted: {
        ...accepted,
        payTo: accepted.payTo.toLowerCase(),
        extra: {
          ...accepted.extra,
          verifyingContract: `0x${accepted.extra.verifyingContract
            .slice(2)
            .toUpperCase()}`,
        },
      },
    };

    const response = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentHeader(differentlyCased),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(settle).toHaveBeenCalledWith(differentlyCased, gate.requirements);
  });

  it('rejects an envelope for a different resource before settlement', async () => {
    const paymentPayload = await validPaymentPayload();
    const mismatched = {
      ...paymentPayload,
      resource: { ...paymentPayload.resource, url: '/truth/2' },
    };

    const response = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentHeader(mismatched),
      },
    });

    expect(response.statusCode).toBe(402);
    expect(settle).not.toHaveBeenCalled();
  });

  it('rejects malformed payments without calling settlement', async () => {
    const malformed = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: { [PAYMENT_SIGNATURE_HEADER]: 'not-base64-json' },
    });
    expect(malformed.statusCode).toBe(402);
    expect(settle).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('logs the message from a 400-class facilitator rejection without the signature', async () => {
    const facilitatorMessage =
      'Invalid request: paymentPayload.resource: Required, paymentPayload.accepted: Required';
    settle.mockResolvedValueOnce({
      success: false,
      message: facilitatorMessage,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: { [PAYMENT_SIGNATURE_HEADER]: await validPaymentHeader() },
    });

    expect(response.statusCode).toBe(402);
    expect(response.json()).toMatchObject({ reason: facilitatorMessage });
    expect(logWarn).toHaveBeenCalledWith(
      {
        success: false,
        errorReason: facilitatorMessage,
        payer: null,
        transaction: null,
      },
      'Circle truth payment settlement rejected',
    );
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(SIGNATURE);
  });

  it('returns 503 without leaking the signal when the payment layer is down', async () => {
    settle.mockRejectedValueOnce(new Error('Gateway unavailable'));

    const response = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: { [PAYMENT_SIGNATURE_HEADER]: await validPaymentHeader() },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'Truth payment layer is temporarily unavailable.',
    });
    expect(response.body).not.toContain('fairValueYesRaw');
    expect(logWarn).toHaveBeenCalledWith(
      {
        success: false,
        errorReason: 'Gateway unavailable',
        payer: null,
        transaction: null,
      },
      'Circle truth payment settlement failed',
    );
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(SIGNATURE);
  });
});

describe('truth seller configuration degrade gate', () => {
  it('defaults to disabled, preserving the unpaid Stage 1 endpoint', () => {
    const config = loadTruthSellerConfig({});

    expect(config.mode).toBe('disabled');
    expect(createTruthPaymentGate(config)).toBeUndefined();
  });

  it('requires a public seller address only when Circle mode is enabled', () => {
    expect(() =>
      loadTruthSellerConfig({ PREDEX_TRUTH_SELLER_MODE: 'circle' }),
    ).toThrow(/PREDEX_TRUTH_SELLER_ADDRESS/u);
  });
});
