import { BatchEvmScheme } from '@circle-fin/x402-batching/client';
import {
  TRUTH_ACCESS_HEADER,
  type TruthSignalResponse,
} from '@predex-pump/shared';
import {
  AGENTKIT,
  createAgentkitClient,
  formatSIWEMessage,
  type AgentBookVerifier,
  type AgentkitExtension,
  type AgentkitPayload,
  type CompleteAgentkitInfo,
} from '@worldcoin/agentkit';
import type { FastifyInstance } from 'fastify';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/api/server.js';
import { ServerEventBus } from '../src/events/bus.js';
import {
  PrismaAgentkitTrialStore,
  WORLD_AGENTKIT_FREE_USES,
  WORLD_AGENTKIT_TRIAL_SCOPE,
  WorldAgentkitTruthTrialGate,
} from '../src/truth-payment/agentkit.js';
import {
  CircleTruthPaymentGate,
  type CircleFacilitator,
} from '../src/truth-payment/circle-provider.js';
import {
  decodePaymentHeader,
  encodePaymentHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type TruthPaymentRequired,
} from '../src/truth-payment/types.js';
import { resetDatabase, testPrisma } from './database.js';
import { seedContractData } from './fixtures.js';

const PUBLIC_ORIGIN = 'http://predex.test';
const ARC_RPC_URL = 'http://127.0.0.1:1';
const SELLER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TRANSACTION = `0x${'c'.repeat(64)}`;
const HUMAN_ID = 'anonymous-world-human-do-not-log';
const AGENT_ONE = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const AGENT_TWO = privateKeyToAccount(`0x${'22'.repeat(32)}`);

function responseHeaders(
  source: Record<string, string | string[] | number | undefined>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

function fastifyFetch(app: FastifyInstance): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== 'GET') {
      throw new Error('World AgentKit test transport only supports GET.');
    }
    const headers = Object.fromEntries(request.headers.entries());
    headers.host = url.host;
    const injected = await app.inject({
      method: 'GET',
      url: `${url.pathname}${url.search}`,
      headers,
    });
    return new Response(injected.body, {
      status: injected.statusCode,
      headers: responseHeaders(injected.headers),
    });
  };
}

async function verifyEoaAgentkitPayload(payload: AgentkitPayload) {
  const { address, signature, ...info } = payload;
  const valid = await verifyMessage({
    address: address as `0x${string}`,
    message: formatSIWEMessage(info as CompleteAgentkitInfo, address),
    signature: signature as `0x${string}`,
  });
  return valid
    ? { valid: true as const, address }
    : { valid: false as const, error: 'invalid signature' };
}

function worldClient(
  account: typeof AGENT_ONE,
  fetchImplementation: typeof fetch,
) {
  return createAgentkitClient({
    fetch: fetchImplementation,
    signer: {
      address: account.address,
      chainId: 'eip155:5042002',
      type: 'eip191',
      signMessage: (message) => account.signMessage({ message }),
    },
  });
}

async function challenge(fetchImplementation: typeof fetch, marketId = '1') {
  const response = await fetchImplementation(
    `${PUBLIC_ORIGIN}/truth/${marketId}`,
  );
  expect(response.status).toBe(402);
  const body = (await response.json()) as TruthPaymentRequired;
  const extension = body.extensions?.[AGENTKIT] as
    | (AgentkitExtension & { mode?: unknown })
    | undefined;
  expect(extension).toBeDefined();
  return { response, body, extension: extension as AgentkitExtension & { mode?: unknown } };
}

describe('World AgentKit human-backed truth trial', () => {
  let app: FastifyInstance;
  let appFetch: typeof fetch;
  const lookupHuman = vi.fn<AgentBookVerifier['lookupHuman']>();
  const settle = vi.fn<CircleFacilitator['settle']>();
  const logInfo = vi.fn();
  const logWarn = vi.fn();

  beforeAll(async () => {
    const circle = new CircleTruthPaymentGate({
      sellerAddress: SELLER,
      amountRaw: 100n,
      facilitator: { settle },
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const agentkit = new WorldAgentkitTruthTrialGate({
      prisma: testPrisma,
      publicApiOrigin: PUBLIC_ORIGIN,
      rpcUrl: ARC_RPC_URL,
      agentBook: { lookupHuman },
      logger: { info: logInfo, warn: logWarn },
      verifySignature: verifyEoaAgentkitPayload,
      externalTimeoutMs: 50,
    });
    app = await buildServer({
      prisma: testPrisma,
      eventBus: new ServerEventBus(),
      truthPaymentGate: circle,
      truthAgentTrialGate: agentkit,
      logger: false,
    });
    appFetch = fastifyFetch(app);
  });

  beforeEach(async () => {
    lookupHuman.mockReset();
    lookupHuman.mockResolvedValue(HUMAN_ID);
    settle.mockReset();
    settle.mockResolvedValue({
      success: true,
      payer: AGENT_ONE.address,
      transaction: TRANSACTION,
      network: 'eip155:5042002',
    });
    logInfo.mockReset();
    logWarn.mockReset();
    await resetDatabase();
    await seedContractData();
  });

  afterAll(async () => {
    await app.close();
    await testPrisma.$disconnect();
  });

  it('advertises a fresh three-use Arc trial bound to the configured API origin', async () => {
    const before = Date.now();
    const { response, body, extension } = await challenge(appFetch);
    const after = Date.now();

    expect(body).toMatchObject({
      x402Version: 2,
      error: 'Payment required for this truth signal.',
      resource: { url: '/truth/1' },
      accepts: [{ network: 'eip155:5042002', amount: '100' }],
    });
    expect(extension.mode).toEqual({ type: 'free-trial', uses: 3 });
    expect(extension.info).toMatchObject({
      domain: 'predex.test',
      uri: `${PUBLIC_ORIGIN}/truth/1`,
      version: '1',
      resources: [`${PUBLIC_ORIGIN}/truth/1`],
    });
    expect(extension.supportedChains).toEqual(
      expect.arrayContaining([
        { chainId: 'eip155:5042002', type: 'eip191' },
        { chainId: 'eip155:5042002', type: 'eip1271' },
      ]),
    );
    expect(new Date(extension.info.issuedAt).getTime()).toBeGreaterThanOrEqual(
      before,
    );
    expect(new Date(extension.info.issuedAt).getTime()).toBeLessThanOrEqual(after);
    expect(extension.info.nonce).toMatch(/^[0-9a-f]{32}$/u);
    const header = decodePaymentHeader(
      response.headers.get(PAYMENT_REQUIRED_HEADER) ?? '',
    ) as TruthPaymentRequired;
    expect(header.extensions?.[AGENTKIT]).toEqual(extension);
  });

  it('grants three free reads, then preserves the existing Circle settlement path', async () => {
    const client = worldClient(AGENT_ONE, appFetch);
    for (let use = 0; use < WORLD_AGENTKIT_FREE_USES; use += 1) {
      const response = await client.fetch(`${PUBLIC_ORIGIN}/truth/1`);
      expect(response.status).toBe(200);
      expect(response.headers.get(TRUTH_ACCESS_HEADER)).toBe('world-agentkit');
      expect(((await response.json()) as TruthSignalResponse).marketId).toBe('1');
    }
    const exhausted = await client.fetch(`${PUBLIC_ORIGIN}/truth/1`);
    expect(exhausted.status).toBe(402);
    expect(settle).not.toHaveBeenCalled();

    const required = decodePaymentHeader(
      exhausted.headers.get(PAYMENT_REQUIRED_HEADER) ?? '',
    ) as TruthPaymentRequired;
    const scheme = new BatchEvmScheme({
      address: AGENT_ONE.address,
      signTypedData: (typedData) => AGENT_ONE.signTypedData(typedData),
    });
    const signed = await scheme.createPaymentPayload(
      required.x402Version,
      required.accepts[0],
    );
    const paymentSignature = encodePaymentHeader({
      x402Version: signed.x402Version,
      resource: required.resource,
      accepted: required.accepts[0],
      payload: signed.payload,
    });
    const paid = await appFetch(`${PUBLIC_ORIGIN}/truth/1`, {
      headers: { [PAYMENT_SIGNATURE_HEADER]: paymentSignature },
    });

    expect(paid.status).toBe(200);
    expect(paid.headers.get(TRUTH_ACCESS_HEADER)).toBe('circle-x402');
    expect(settle).toHaveBeenCalledOnce();
    expect(await testPrisma.agentkitTrialNonce.count()).toBe(3);
    const usage = await testPrisma.agentkitTrialUsage.findMany();
    expect(usage).toHaveLength(1);
    expect(usage[0]?.uses).toBe(3);
    expect(usage[0]?.humanKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(usage[0]?.humanKey).not.toBe(HUMAN_ID);
    const serializedLogs = JSON.stringify([
      logInfo.mock.calls,
      logWarn.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(HUMAN_ID);
    expect(serializedLogs).not.toContain(paymentSignature);
  });

  it('shares one trial across two agent wallets backed by the same human', async () => {
    const first = worldClient(AGENT_ONE, appFetch);
    const second = worldClient(AGENT_TWO, appFetch);
    const statuses = [];
    statuses.push((await first.fetch(`${PUBLIC_ORIGIN}/truth/1`)).status);
    statuses.push((await second.fetch(`${PUBLIC_ORIGIN}/truth/2`)).status);
    statuses.push((await first.fetch(`${PUBLIC_ORIGIN}/truth/2`)).status);
    statuses.push((await second.fetch(`${PUBLIC_ORIGIN}/truth/1`)).status);

    expect(statuses).toEqual([200, 200, 200, 402]);
    expect(await testPrisma.agentkitTrialUsage.findMany()).toEqual([
      expect.objectContaining({
        scope: WORLD_AGENTKIT_TRIAL_SCOPE,
        uses: 3,
      }),
    ]);
  });

  it('atomically grants only three concurrent fresh challenges', async () => {
    const client = worldClient(AGENT_ONE, appFetch);
    const challenges = await Promise.all(
      Array.from({ length: 4 }, () => challenge(appFetch)),
    );
    const headers = await Promise.all(
      challenges.map(({ extension }) => client.createHeader(extension)),
    );
    const responses = await Promise.all(
      headers.map((header) =>
        appFetch(`${PUBLIC_ORIGIN}/truth/1`, {
          headers: { [AGENTKIT]: header },
        }),
      ),
    );

    expect(responses.filter(({ status }) => status === 200)).toHaveLength(3);
    expect(responses.filter(({ status }) => status === 402)).toHaveLength(1);
    expect((await testPrisma.agentkitTrialUsage.findMany())[0]?.uses).toBe(3);
    expect(await testPrisma.agentkitTrialNonce.count()).toBe(3);
  });

  it('allows at most one grant when one signed header is replayed concurrently', async () => {
    const client = worldClient(AGENT_ONE, appFetch);
    const { extension } = await challenge(appFetch);
    const header = await client.createHeader(extension);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        appFetch(`${PUBLIC_ORIGIN}/truth/1`, {
          headers: { [AGENTKIT]: header },
        }),
      ),
    );

    expect(responses.filter(({ status }) => status === 200)).toHaveLength(1);
    expect((await testPrisma.agentkitTrialUsage.findMany())[0]?.uses).toBe(1);
    expect(await testPrisma.agentkitTrialNonce.count()).toBe(1);
  });

  it('never bypasses payment for malformed, mismatched, unregistered, or unavailable identity', async () => {
    const client = worldClient(AGENT_ONE, appFetch);
    const { extension } = await challenge(appFetch);
    const malformed = await appFetch(`${PUBLIC_ORIGIN}/truth/1`, {
      headers: { [AGENTKIT]: 'not-base64-json' },
    });
    expect(malformed.status).toBe(402);

    const wrongResource = await client.createHeader(extension);
    expect(
      (
        await appFetch(`${PUBLIC_ORIGIN}/truth/2`, {
          headers: { [AGENTKIT]: wrongResource },
        })
      ).status,
    ).toBe(402);

    const wrongDomain = await client.createHeader({
      ...extension,
      info: { ...extension.info, domain: 'wrong.example' },
    });
    expect(
      (
        await appFetch(`${PUBLIC_ORIGIN}/truth/1`, {
          headers: { [AGENTKIT]: wrongDomain },
        })
      ).status,
    ).toBe(402);

    const valid = await client.createHeader(extension);
    const badSignaturePayload = JSON.parse(
      Buffer.from(valid, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    badSignaturePayload.signature = `0x${'00'.repeat(65)}`;
    const badSignature = Buffer.from(
      JSON.stringify(badSignaturePayload),
      'utf8',
    ).toString('base64');
    expect(
      (
        await appFetch(`${PUBLIC_ORIGIN}/truth/1`, {
          headers: { [AGENTKIT]: badSignature },
        })
      ).status,
    ).toBe(402);

    const expiredExtension: AgentkitExtension = {
      ...extension,
      info: {
        ...extension.info,
        issuedAt: new Date(Date.now() - 600_000).toISOString(),
        expirationTime: new Date(Date.now() - 300_000).toISOString(),
      },
    };
    const expired = await client.createHeader(expiredExtension);
    expect(
      (
        await appFetch(`${PUBLIC_ORIGIN}/truth/1`, {
          headers: { [AGENTKIT]: expired },
        })
      ).status,
    ).toBe(402);

    lookupHuman.mockResolvedValueOnce(null);
    expect((await client.fetch(`${PUBLIC_ORIGIN}/truth/1`)).status).toBe(402);
    lookupHuman.mockImplementationOnce(
      async () => new Promise<string | null>(() => undefined),
    );
    expect((await client.fetch(`${PUBLIC_ORIGIN}/truth/1`)).status).toBe(402);
    expect(await testPrisma.agentkitTrialUsage.count()).toBe(0);
    expect(await testPrisma.agentkitTrialNonce.count()).toBe(0);
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('timed out');
  });

  it('keeps the quota after replacing the storage instance', async () => {
    const first = new PrismaAgentkitTrialStore(testPrisma);
    for (let use = 0; use < 3; use += 1) {
      await expect(
        first.tryGrant({
          scope: WORLD_AGENTKIT_TRIAL_SCOPE,
          humanId: HUMAN_ID,
          nonce: `nonce-${use}`,
          limit: 3,
        }),
      ).resolves.toBe(true);
    }
    const afterRestart = new PrismaAgentkitTrialStore(testPrisma);
    await expect(
      afterRestart.tryGrant({
        scope: WORLD_AGENTKIT_TRIAL_SCOPE,
        humanId: HUMAN_ID,
        nonce: 'nonce-after-restart',
        limit: 3,
      }),
    ).resolves.toBe(false);
    expect(await testPrisma.agentkitTrialNonce.count()).toBe(3);
  });
});
