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

describe('Circle x402 truth seller', () => {
  let app: FastifyInstance;
  let gate: CircleTruthPaymentGate;
  const settle = vi.fn<CircleFacilitator['settle']>();

  beforeAll(async () => {
    gate = new CircleTruthPaymentGate({
      sellerAddress: SELLER,
      amountRaw: 100n,
      facilitator: { settle },
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

  function validPaymentHeader(): string {
    return encodePaymentHeader({
      x402Version: 2,
      resource: { url: '/truth/1' },
      accepted: gate.requirements,
      payload: { authorization: { from: PAYER } },
    });
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

  it('returns the signal only after the mocked Gateway facilitator settles', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: { [PAYMENT_SIGNATURE_HEADER]: validPaymentHeader() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<TruthSignalResponse>().fairValueYesRaw).toBe('614166');
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        x402Version: 2,
        accepted: gate.requirements,
      }),
      gate.requirements,
    );
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

  it('rejects malformed or mismatched payments without calling settlement', async () => {
    const malformed = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: { [PAYMENT_SIGNATURE_HEADER]: 'not-base64-json' },
    });
    expect(malformed.statusCode).toBe(402);

    const mismatched = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: encodePaymentHeader({
          x402Version: 2,
          accepted: { ...gate.requirements, amount: '1' },
          payload: {},
        }),
      },
    });
    expect(mismatched.statusCode).toBe(402);
    expect(settle).not.toHaveBeenCalled();
  });

  it('returns 503 without leaking the signal when the payment layer is down', async () => {
    settle.mockRejectedValueOnce(new Error('Gateway unavailable'));

    const response = await app.inject({
      method: 'GET',
      url: '/truth/1',
      headers: { [PAYMENT_SIGNATURE_HEADER]: validPaymentHeader() },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'Truth payment layer is temporarily unavailable.',
    });
    expect(response.body).not.toContain('fairValueYesRaw');
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
