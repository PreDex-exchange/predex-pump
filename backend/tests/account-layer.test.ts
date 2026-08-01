import type {
  AccountProfileResponse,
  SessionResponse,
  SiweNonceResponse,
} from '@predex-pump/shared';
import type { FastifyInstance } from 'fastify';
import {
  createPublicClient,
  custom,
  type LocalAccount,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage, verifySiweMessage } from 'viem/siwe';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountLayerConfig } from '../src/account/config.js';
import type {
  SiweVerifier,
  SiweVerifierInput,
} from '../src/account/service.js';
import type { GatewayBalanceReader } from '../src/gateway/balance.js';
import { buildServer } from '../src/api/server.js';
import { ServerEventBus } from '../src/events/bus.js';
import { resetDatabase, testPrisma } from './database.js';
import { seedContractData, TRADE_TX, TRADER } from './fixtures.js';

const accountConfig: AccountLayerConfig = {
  webOrigin: 'http://localhost:3000',
  siweDomain: 'localhost:3000',
  siweUri: 'http://localhost:3000',
  siweStatement:
    'Sign in to predex.fun to save your profile, watchlist, and recent activity. Trading stays wallet-only.',
  chainId: 5_042_002,
  nonceTtlMs: 5 * 60 * 1_000,
  sessionTtlMs: 7 * 24 * 60 * 60 * 1_000,
  secureCookies: false,
  rpcUrl: 'http://unused.invalid',
};

const verificationClient = createPublicClient({
  transport: custom({
    request: async () => {
      throw new Error('Tests never make contract-wallet RPC calls');
    },
  }),
});

const testVerifier: SiweVerifier = async (input: SiweVerifierInput) => {
  try {
    return await verifySiweMessage(verificationClient, input);
  } catch {
    return false;
  }
};

const gatewayBalanceReader: GatewayBalanceReader = {
  read: vi.fn(),
};

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers['set-cookie'];
  if (typeof setCookie !== 'string') throw new Error('Session cookie was not set');
  const cookie = setCookie.split(';')[0];
  if (!cookie) throw new Error('Session cookie was empty');
  return cookie;
}

async function issueMessage(
  app: FastifyInstance,
  signer: LocalAccount,
  domain = accountConfig.siweDomain,
) {
  const nonceResponse = await app.inject({
    method: 'POST',
    url: '/auth/siwe/nonce',
  });
  expect(nonceResponse.statusCode).toBe(200);
  const nonce = nonceResponse.json<SiweNonceResponse>();
  const message = createSiweMessage({
    address: signer.address,
    chainId: nonce.chainId,
    domain,
    uri: nonce.uri,
    version: '1',
    statement: nonce.statement,
    nonce: nonce.nonce,
    issuedAt: new Date(nonce.issuedAt),
    expirationTime: new Date(nonce.expirationTime),
  });
  return { nonce, message };
}

async function signIn(app: FastifyInstance, signer: LocalAccount) {
  const issued = await issueMessage(app, signer);
  const signature = await signer.signMessage({ message: issued.message });
  const response = await app.inject({
    method: 'POST',
    url: '/auth/siwe/verify',
    payload: { message: issued.message, signature },
  });
  expect(response.statusCode).toBe(200);
  return { ...issued, signature, response, cookie: sessionCookie(response) };
}

describe('wallet-native account layer', () => {
  let app: FastifyInstance;
  let signer: LocalAccount;

  beforeAll(async () => {
    app = await buildServer({
      prisma: testPrisma,
      eventBus: new ServerEventBus(),
      accountLayerConfig: accountConfig,
      siweVerifier: testVerifier,
      gatewayBalanceReader,
      logger: false,
    });
  });

  beforeEach(async () => {
    await resetDatabase();
    await seedContractData();
    // Ephemeral in-memory test signer; no private key is stored or logged.
    signer = privateKeyToAccount(generatePrivateKey());
    vi.mocked(gatewayBalanceReader.read).mockReset();
    vi.mocked(gatewayBalanceReader.read).mockResolvedValue({
      totalRaw: '2500000',
      availableRaw: '2000000',
    });
  });

  afterAll(async () => {
    await app.close();
    await testPrisma.$disconnect();
  });

  it('verifies EIP-4361, binds an HttpOnly cookie to the address, and rejects replay', async () => {
    const signedIn = await signIn(app, signer);
    expect(signedIn.response.json<SessionResponse>()).toMatchObject({
      authenticated: true,
      address: signer.address.toLowerCase(),
    });
    expect(signedIn.response.headers['set-cookie']).toContain('HttpOnly');
    expect(signedIn.response.headers['set-cookie']).toContain('SameSite=Lax');

    const persisted = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: signedIn.cookie },
    });
    expect(persisted.json<SessionResponse>()).toMatchObject({
      authenticated: true,
      address: signer.address.toLowerCase(),
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/auth/siwe/verify',
      payload: { message: signedIn.message, signature: signedIn.signature },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({
      error: expect.stringMatching(/already been used/u),
    });
  });

  it('persists a database session across a fresh server instance and signs out', async () => {
    const signedIn = await signIn(app, signer);
    const reloadedServer = await buildServer({
      prisma: testPrisma,
      eventBus: new ServerEventBus(),
      accountLayerConfig: accountConfig,
      siweVerifier: testVerifier,
      logger: false,
    });
    try {
      const session = await reloadedServer.inject({
        method: 'GET',
        url: '/auth/session',
        headers: { cookie: signedIn.cookie },
      });
      expect(session.json<SessionResponse>()).toMatchObject({
        authenticated: true,
        address: signer.address.toLowerCase(),
      });
      const signOut = await reloadedServer.inject({
        method: 'POST',
        url: '/auth/sign-out',
        headers: { cookie: signedIn.cookie },
      });
      expect(signOut.json<SessionResponse>()).toEqual({ authenticated: false });
      expect(signOut.headers['set-cookie']).toContain('Max-Age=0');
      expect(
        (
          await reloadedServer.inject({
            method: 'GET',
            url: '/auth/session',
            headers: { cookie: signedIn.cookie },
          })
        ).json<SessionResponse>(),
      ).toEqual({ authenticated: false });
    } finally {
      await reloadedServer.close();
    }
  });

  it('rejects an expired nonce before creating a session', async () => {
    const issued = await issueMessage(app, signer);
    await testPrisma.siweNonce.update({
      where: { nonce: issued.nonce.nonce },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const signature = await signer.signMessage({ message: issued.message });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/siwe/verify',
      payload: { message: issued.message, signature },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'SIWE nonce has expired' });
    expect(await testPrisma.authSession.count()).toBe(0);
  });

  it('rejects a signature from a different address without consuming the nonce', async () => {
    const issued = await issueMessage(app, signer);
    const otherSigner = privateKeyToAccount(generatePrivateKey());
    const wrongSignature = await otherSigner.signMessage({ message: issued.message });
    const rejected = await app.inject({
      method: 'POST',
      url: '/auth/siwe/verify',
      payload: { message: issued.message, signature: wrongSignature },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json()).toEqual({ error: 'SIWE signature is invalid' });

    const correctSignature = await signer.signMessage({ message: issued.message });
    const accepted = await app.inject({
      method: 'POST',
      url: '/auth/siwe/verify',
      payload: { message: issued.message, signature: correctSignature },
    });
    expect(accepted.statusCode).toBe(200);
  });

  it('rejects a correctly signed message for the wrong domain', async () => {
    const issued = await issueMessage(app, signer, 'evil.example');
    const signature = await signer.signMessage({ message: issued.message });
    const response = await app.inject({
      method: 'POST',
      url: '/auth/siwe/verify',
      payload: { message: issued.message, signature },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'SIWE message fields do not match this application',
    });
  });

  it('round-trips watchlist and modest behavior state per signed-in address', async () => {
    const { cookie } = await signIn(app, signer);
    const auth = { cookie };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/account/watchlist/1',
          headers: auth,
        })
      ).json(),
    ).toEqual({ marketId: '1', watchlisted: true });

    for (const type of [
      'MARKET_VIEWED',
      'DEDUP_SUGGESTION_ACCEPTED',
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/account/behavior',
        headers: auth,
        payload: { type, marketId: '1' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        behavior: { type, marketId: '1' },
      });
    }

    const profile = (
      await app.inject({
        method: 'GET',
        url: '/account/profile',
        headers: auth,
      })
    ).json<AccountProfileResponse>();
    expect(profile.watchlist.map((market) => market.id)).toEqual(['1']);
    expect(profile.recentlyViewed.map((market) => market.id)).toEqual(['1']);
    expect(profile.behavior).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'MARKET_VIEWED', marketId: '1' }),
        expect.objectContaining({
          type: 'DEDUP_SUGGESTION_ACCEPTED',
          marketId: '1',
        }),
      ]),
    );

    const updated = await app.inject({
      method: 'PATCH',
      url: '/account/profile',
      headers: auth,
      payload: {
        displayName: '  Arc Trader  ',
        preferences: { rememberRecentlyViewed: false },
      },
    });
    expect(updated.json<AccountProfileResponse>().profile).toMatchObject({
      displayName: 'Arc Trader',
      preferences: { rememberRecentlyViewed: false },
    });
    expect(updated.json<AccountProfileResponse>().recentlyViewed).toEqual([]);
    expect(
      await testPrisma.accountBehaviorEvent.count({
        where: {
          accountAddress: signer.address.toLowerCase(),
          type: 'MARKET_VIEWED',
        },
      }),
    ).toBe(0);

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: '/account/watchlist/1',
          headers: auth,
        })
      ).json(),
    ).toEqual({ marketId: '1', watchlisted: false });
  });

  it('assembles created/traded markets and track record only from indexed data', async () => {
    const address = signer.address.toLowerCase();
    await testPrisma.market.update({
      where: { id: '1' },
      data: { creator: address },
    });
    await testPrisma.trade.update({
      where: { id: `${TRADE_TX}:4` },
      data: { account: address, recipient: address },
    });
    await testPrisma.account.create({
      data: {
        address,
        firstSeenAt: 1_700_000_000,
        marketsCreated: 1,
        tradeCount: 1,
        realizedPnlRaw: '100000',
        unrealizedPnlRaw: '500000',
      },
    });
    const { cookie } = await signIn(app, signer);
    const response = await app.inject({
      method: 'GET',
      url: '/account/profile',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const profile = response.json<AccountProfileResponse>();
    expect(profile.createdMarkets.map((market) => market.id)).toEqual(['1']);
    expect(profile.tradedMarkets.map((market) => market.id)).toEqual(['1']);
    expect(profile.trackRecord).toMatchObject({
      marketsCreated: 1,
      marketsTraded: 1,
      tradeCount: 1,
      volumeTradedRaw: '1000000',
      realizedPnlRaw: '100000',
      unrealizedPnlRaw: '500000',
    });
    expect(await testPrisma.userAccount.findUnique({ where: { address } })).not.toHaveProperty(
      'tradeCount',
    );
    expect(TRADER).not.toBe(address);
  });

  it('gates only account features and leaves public indexed reads available', async () => {
    expect(
      (await app.inject({ method: 'GET', url: '/account/profile' })).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/markets' })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: 'GET', url: '/markets/1' })).statusCode).toBe(
      200,
    );
  });

  it('returns Gateway balance reads and degrades without breaking Stage 1', async () => {
    const { cookie } = await signIn(app, signer);
    const balance = await app.inject({
      method: 'GET',
      url: '/account/gateway/balance',
      headers: { cookie },
    });
    expect(balance.statusCode).toBe(200);
    expect(balance.json()).toEqual({
      totalRaw: '2500000',
      availableRaw: '2000000',
    });
    expect(gatewayBalanceReader.read).toHaveBeenCalledWith(
      signer.address.toLowerCase(),
    );

    vi.mocked(gatewayBalanceReader.read).mockRejectedValueOnce(
      new Error('Circle is unreachable'),
    );
    const unavailable = await app.inject({
      method: 'GET',
      url: '/account/gateway/balance',
      headers: { cookie },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      error: 'Circle Gateway balance is temporarily unavailable.',
    });

    const profile = await app.inject({
      method: 'GET',
      url: '/account/profile',
      headers: { cookie },
    });
    expect(profile.statusCode).toBe(200);
  });
});
