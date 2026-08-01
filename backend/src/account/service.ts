import { createHash, randomBytes } from 'node:crypto';

import type {
  AccountBehaviorRecord,
  AccountBehaviorType,
  AccountProfileResponse,
  RecordAccountBehaviorResponse,
  SessionResponse,
  SiweNonceResponse,
  WatchlistMutationResponse,
} from '@predex-pump/shared';
import type { PrismaClient } from '@prisma/client';
import {
  createPublicClient,
  getAddress,
  http,
  isHex,
  type Address,
  type Hex,
} from 'viem';
import {
  generateSiweNonce,
  parseSiweMessage,
  verifySiweMessage,
} from 'viem/siwe';

import { HttpError } from '../api/input.js';
import {
  getMarketsByIds,
  listMarkets,
} from '../api/queries.js';
import type { AccountLayerConfig } from './config.js';

export const SESSION_COOKIE_NAME = 'predex_session';
const MAX_BEHAVIOR_RECORDS = 50;
const MAX_PROFILE_MARKETS = 50;
const BEHAVIOR_TYPES = new Set<AccountBehaviorType>([
  'MARKET_VIEWED',
  'DEDUP_SUGGESTION_ACCEPTED',
  'DEDUP_SUGGESTION_REJECTED',
]);

export interface SiweVerifierInput {
  address: Address;
  domain: string;
  message: string;
  nonce: string;
  signature: Hex;
  time: Date;
}

export type SiweVerifier = (input: SiweVerifierInput) => Promise<boolean>;

export interface VerifiedSession {
  response: Extract<SessionResponse, { authenticated: true }>;
  token: string;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

function sessionCookieAttributes(
  config: AccountLayerConfig,
  expiresAt: Date,
): string {
  const maxAge = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1_000),
  );
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
    ...(config.secureCookies ? ['Secure'] : []),
  ].join('; ');
}

export function serializeSessionCookie(
  token: string,
  expiresAt: Date,
  config: AccountLayerConfig,
): string {
  return `${SESSION_COOKIE_NAME}=${token}; ${sessionCookieAttributes(config, expiresAt)}`;
}

export function serializeClearedSessionCookie(
  config: AccountLayerConfig,
): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${config.secureCookies ? '; Secure' : ''}`;
}

function behaviorRecord(row: {
  type: string;
  marketId: string;
  occurredAt: Date;
}): AccountBehaviorRecord {
  return {
    type: row.type as AccountBehaviorType,
    marketId: row.marketId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

function assertBehaviorType(value: string): asserts value is AccountBehaviorType {
  if (!BEHAVIOR_TYPES.has(value as AccountBehaviorType)) {
    throw new HttpError(400, 'type is not a supported account behavior');
  }
}

export class AccountService {
  private readonly verifySignature: SiweVerifier;

  constructor(
    private readonly prisma: PrismaClient,
    readonly config: AccountLayerConfig,
    verifier?: SiweVerifier,
  ) {
    if (verifier) {
      this.verifySignature = verifier;
      return;
    }
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    this.verifySignature = async (input) => {
      try {
        return await verifySiweMessage(client, input);
      } catch {
        return false;
      }
    };
  }

  async issueNonce(now = new Date()): Promise<SiweNonceResponse> {
    const nonce = generateSiweNonce();
    const expiresAt = new Date(now.getTime() + this.config.nonceTtlMs);
    await this.prisma.siweNonce.create({
      data: {
        nonce,
        domain: this.config.siweDomain,
        uri: this.config.siweUri,
        issuedAt: now,
        expiresAt,
      },
    });
    return {
      nonce,
      domain: this.config.siweDomain,
      uri: this.config.siweUri,
      chainId: this.config.chainId,
      statement: this.config.siweStatement,
      issuedAt: now.toISOString(),
      expirationTime: expiresAt.toISOString(),
    };
  }

  async verify(
    message: string,
    signature: string,
    now = new Date(),
  ): Promise<VerifiedSession> {
    if (!message || message.length > 10_000 || !isHex(signature)) {
      throw new HttpError(400, 'message and signature must be valid SIWE values');
    }

    const parsed = parseSiweMessage(message);
    if (
      !parsed.address ||
      !parsed.nonce ||
      !parsed.issuedAt ||
      !parsed.expirationTime ||
      parsed.domain !== this.config.siweDomain ||
      parsed.uri !== this.config.siweUri ||
      parsed.chainId !== this.config.chainId ||
      parsed.version !== '1' ||
      parsed.statement !== this.config.siweStatement
    ) {
      throw new HttpError(401, 'SIWE message fields do not match this application');
    }
    const parsedNonce = parsed.nonce;

    const nonce = await this.prisma.siweNonce.findUnique({
      where: { nonce: parsedNonce },
    });
    if (!nonce || nonce.consumedAt) {
      throw new HttpError(401, 'SIWE nonce is missing or has already been used');
    }
    if (nonce.expiresAt.getTime() <= now.getTime()) {
      throw new HttpError(401, 'SIWE nonce has expired');
    }
    if (
      nonce.domain !== this.config.siweDomain ||
      nonce.uri !== this.config.siweUri ||
      nonce.issuedAt.getTime() !== parsed.issuedAt.getTime() ||
      nonce.expiresAt.getTime() !== parsed.expirationTime.getTime()
    ) {
      throw new HttpError(401, 'SIWE nonce does not match the signed message');
    }

    let address: Address;
    try {
      address = getAddress(parsed.address);
    } catch {
      throw new HttpError(401, 'SIWE address is invalid');
    }
    const valid = await this.verifySignature({
      address,
      domain: this.config.siweDomain,
      message,
      nonce: parsedNonce,
      signature: signature as Hex,
      time: now,
    });
    if (!valid) throw new HttpError(401, 'SIWE signature is invalid');

    const normalizedAddress = address.toLowerCase();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMs);
    await this.prisma.$transaction(async (transaction) => {
      const consumed = await transaction.siweNonce.updateMany({
        where: {
          nonce: parsedNonce,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) {
        throw new HttpError(401, 'SIWE nonce is expired or has already been used');
      }
      await transaction.userAccount.upsert({
        where: { address: normalizedAddress },
        create: { address: normalizedAddress },
        update: {},
      });
      await transaction.authSession.create({
        data: {
          tokenHash: tokenHash(token),
          accountAddress: normalizedAddress,
          createdAt: now,
          expiresAt,
        },
      });
    });

    return {
      token,
      response: {
        authenticated: true,
        address: normalizedAddress as Address,
        expiresAt: expiresAt.toISOString(),
      },
    };
  }

  async session(cookieHeader: string | undefined, now = new Date()) {
    const token = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (!token) return null;
    const session = await this.prisma.authSession.findUnique({
      where: { tokenHash: tokenHash(token) },
    });
    if (!session) return null;
    if (session.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.authSession.deleteMany({
        where: { tokenHash: session.tokenHash },
      });
      return null;
    }
    return {
      authenticated: true as const,
      address: session.accountAddress as Address,
      expiresAt: session.expiresAt.toISOString(),
      tokenHash: session.tokenHash,
    };
  }

  async sessionResponse(cookieHeader: string | undefined): Promise<SessionResponse> {
    const session = await this.session(cookieHeader);
    if (!session) return { authenticated: false };
    return {
      authenticated: true,
      address: session.address,
      expiresAt: session.expiresAt,
    };
  }

  async signOut(cookieHeader: string | undefined): Promise<void> {
    const token = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (!token) return;
    await this.prisma.authSession.deleteMany({
      where: { tokenHash: tokenHash(token) },
    });
  }

  async profile(address: string): Promise<AccountProfileResponse> {
    const [profile, indexed, created, trades, watchlistRows, behaviorRows] =
      await Promise.all([
        this.prisma.userAccount.findUniqueOrThrow({ where: { address } }),
        this.prisma.account.findUnique({ where: { address } }),
        listMarkets(this.prisma, {
          creator: address,
          limit: MAX_PROFILE_MARKETS,
        }),
        this.prisma.trade.findMany({
          where: { account: address },
          select: {
            marketId: true,
            costRaw: true,
            blockNumber: true,
            logIndex: true,
          },
          orderBy: [{ blockNumber: 'desc' }, { logIndex: 'desc' }],
        }),
        this.prisma.accountWatchlist.findMany({
          where: { accountAddress: address },
          orderBy: { addedAt: 'desc' },
        }),
        this.prisma.accountBehaviorEvent.findMany({
          where: { accountAddress: address },
          orderBy: { occurredAt: 'desc' },
          take: MAX_BEHAVIOR_RECORDS,
        }),
      ]);

    const tradedMarketIds = [...new Set(trades.map((trade) => trade.marketId))];
    const recentlyViewedIds = behaviorRows
      .filter((event) => event.type === 'MARKET_VIEWED')
      .map((event) => event.marketId);
    const [tradedMarkets, watchlist, recentlyViewed] = await Promise.all([
      getMarketsByIds(this.prisma, tradedMarketIds.slice(0, MAX_PROFILE_MARKETS)),
      getMarketsByIds(
        this.prisma,
        watchlistRows.map((entry) => entry.marketId),
      ),
      profile.rememberRecentlyViewed
        ? getMarketsByIds(this.prisma, recentlyViewedIds)
        : Promise.resolve([]),
    ]);

    return {
      profile: {
        address: address as Address,
        displayName: profile.displayName,
        preferences: {
          rememberRecentlyViewed: profile.rememberRecentlyViewed,
        },
        createdAt: profile.createdAt.toISOString(),
        updatedAt: profile.updatedAt.toISOString(),
      },
      trackRecord: {
        marketsCreated: indexed?.marketsCreated ?? created.items.length,
        marketsTraded: tradedMarketIds.length,
        tradeCount: indexed?.tradeCount ?? trades.length,
        volumeTradedRaw: trades
          .reduce((sum, trade) => sum + BigInt(trade.costRaw), 0n)
          .toString(),
        realizedPnlRaw: indexed?.realizedPnlRaw ?? '0',
        unrealizedPnlRaw: indexed?.unrealizedPnlRaw ?? '0',
        dedupSuggestionsAccepted: behaviorRows.filter(
          (event) => event.type === 'DEDUP_SUGGESTION_ACCEPTED',
        ).length,
        dedupSuggestionsRejected: behaviorRows.filter(
          (event) => event.type === 'DEDUP_SUGGESTION_REJECTED',
        ).length,
      },
      createdMarkets: created.items,
      tradedMarkets,
      watchlist,
      recentlyViewed,
      behavior: behaviorRows.map(behaviorRecord),
    };
  }

  async updateProfile(
    address: string,
    input: {
      displayName?: string | null;
      rememberRecentlyViewed?: boolean;
    },
  ): Promise<AccountProfileResponse> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.userAccount.update({
        where: { address },
        data: {
          ...(input.displayName === undefined
            ? {}
            : { displayName: input.displayName }),
          ...(input.rememberRecentlyViewed === undefined
            ? {}
            : { rememberRecentlyViewed: input.rememberRecentlyViewed }),
        },
      });
      if (input.rememberRecentlyViewed === false) {
        await transaction.accountBehaviorEvent.deleteMany({
          where: { accountAddress: address, type: 'MARKET_VIEWED' },
        });
      }
    });
    return this.profile(address);
  }

  async setWatchlist(
    address: string,
    marketId: string,
    watchlisted: boolean,
  ): Promise<WatchlistMutationResponse> {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      select: { id: true },
    });
    if (!market) throw new HttpError(404, `Market ${marketId} was not found`);
    if (watchlisted) {
      await this.prisma.accountWatchlist.upsert({
        where: { accountAddress_marketId: { accountAddress: address, marketId } },
        create: { accountAddress: address, marketId },
        update: {},
      });
    } else {
      await this.prisma.accountWatchlist.deleteMany({
        where: { accountAddress: address, marketId },
      });
    }
    return { marketId, watchlisted };
  }

  async recordBehavior(
    address: string,
    type: string,
    marketId: string,
    now = new Date(),
  ): Promise<RecordAccountBehaviorResponse> {
    assertBehaviorType(type);
    const [market, profile] = await Promise.all([
      this.prisma.market.findUnique({
        where: { id: marketId },
        select: { id: true },
      }),
      this.prisma.userAccount.findUniqueOrThrow({ where: { address } }),
    ]);
    if (!market) throw new HttpError(404, `Market ${marketId} was not found`);
    if (type === 'MARKET_VIEWED' && !profile.rememberRecentlyViewed) {
      throw new HttpError(409, 'Recently viewed retention is disabled');
    }

    const row = await this.prisma.$transaction(async (transaction) => {
      if (type !== 'MARKET_VIEWED') {
        await transaction.accountBehaviorEvent.deleteMany({
          where: {
            accountAddress: address,
            marketId,
            type:
              type === 'DEDUP_SUGGESTION_ACCEPTED'
                ? 'DEDUP_SUGGESTION_REJECTED'
                : 'DEDUP_SUGGESTION_ACCEPTED',
          },
        });
      }
      const saved = await transaction.accountBehaviorEvent.upsert({
        where: {
          accountAddress_type_marketId: {
            accountAddress: address,
            type,
            marketId,
          },
        },
        create: { accountAddress: address, type, marketId, occurredAt: now },
        update: { occurredAt: now },
      });
      const overflow = await transaction.accountBehaviorEvent.findMany({
        where: { accountAddress: address },
        orderBy: { occurredAt: 'desc' },
        skip: MAX_BEHAVIOR_RECORDS,
        select: { id: true },
      });
      if (overflow.length > 0) {
        await transaction.accountBehaviorEvent.deleteMany({
          where: { id: { in: overflow.map((event) => event.id) } },
        });
      }
      return saved;
    });
    return { behavior: behaviorRecord(row) };
  }
}
