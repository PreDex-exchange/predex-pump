// REST contract — paths + request params + response bodies.
// The backend implements these exactly; the frontend's api-client is generated from them.
// All amounts are raw strings per the units convention in domain.ts.

import type {
  Account,
  AccountBehaviorRecord,
  AccountBehaviorType,
  AccountProfile,
  AccountTrackRecord,
  Address,
  ActivityEvent,
  DedupCandidate,
  Market,
  MarketPhase,
  OrderBook,
  Pnl,
  Position,
  PricePoint,
  RegistryConfig,
  Resolution,
  Trade,
  TruthSignal,
} from './domain';

/** Opaque forward cursor for keyset pagination (base64 of the last seen sort key). */
export type Cursor = string;

export interface Page<T> {
  items: T[];
  nextCursor: Cursor | null;
}

// GET /markets?phase=&creator=&limit=&cursor=
export interface ListMarketsQuery {
  phase?: MarketPhase;
  creator?: string;
  limit?: number; // default 50, max 200
  cursor?: Cursor;
}
export type ListMarketsResponse = Page<Market>;

// GET /markets/:id
export interface MarketDetailResponse {
  market: Market;
  recentTrades: Trade[];
  resolution: Resolution | null;
}

// GET /markets/:id/book  → both outcomes of the graduated book (empty until graduation)
export interface MarketBookResponse {
  marketId: string;
  yes: OrderBook;
  no: OrderBook;
}

// GET /orderbook/:tokenId  → single-token ladder (plan-specified path)
export type OrderBookResponse = OrderBook;

// GET /markets/:id/prices?fromTs=&limit=  → price curve, derived from the TradeState stream
export interface PriceHistoryQuery {
  fromTs?: number;
  limit?: number; // default 500, max 2000
}
export interface PriceHistoryResponse {
  marketId: string;
  points: PricePoint[];
}

// GET /truth/:marketId → explainable estimate from the indexed read model
export type TruthSignalResponse = TruthSignal;

// GET /config  → registry-level params + committee set (needed before a market exists)
export type ConfigResponse = RegistryConfig;

// GET /accounts/:addr
export interface AccountResponse {
  account: Account;
  positions: Position[];
  recentTrades: Trade[];
  pnl: Pnl;
}

// POST /auth/siwe/nonce
export interface SiweNonceResponse {
  nonce: string;
  domain: string;
  uri: string;
  chainId: number;
  statement: string;
  issuedAt: string;
  expirationTime: string;
}

// POST /auth/siwe/verify
export interface SiweVerifyRequest {
  message: string;
  signature: `0x${string}`;
}

export interface AuthenticatedSession {
  authenticated: true;
  address: Address;
  expiresAt: string;
}

export interface AnonymousSession {
  authenticated: false;
}

// GET /auth/session and POST /auth/sign-out
export type SessionResponse = AuthenticatedSession | AnonymousSession;

// GET /account/profile
export interface AccountProfileResponse {
  profile: AccountProfile;
  trackRecord: AccountTrackRecord;
  /** Indexed markets, ordered newest first. */
  createdMarkets: Market[];
  /** Indexed markets, ordered by the account's latest trade. */
  tradedMarkets: Market[];
  /** Off-chain watchlist entries resolved through the indexed market read model. */
  watchlist: Market[];
  /** Last view per market, capped by the backend and resolved through the indexer. */
  recentlyViewed: Market[];
  /** Transparent list of the modest behavior records retained for this address. */
  behavior: AccountBehaviorRecord[];
}

// PATCH /account/profile
export interface UpdateAccountProfileRequest {
  displayName?: string | null;
  preferences?: {
    rememberRecentlyViewed?: boolean;
  };
}

// PUT or DELETE /account/watchlist/:marketId
export interface WatchlistMutationResponse {
  marketId: string;
  watchlisted: boolean;
}

// POST /account/behavior
export interface RecordAccountBehaviorRequest {
  type: AccountBehaviorType;
  /** Viewed market, or the existing market presented by the dedup suggestion. */
  marketId: string;
}

export interface RecordAccountBehaviorResponse {
  behavior: AccountBehaviorRecord;
}

// GET /activity?marketId=&account=&limit=&cursor=
export interface ActivityQuery {
  marketId?: string;
  account?: string;
  limit?: number; // default 50, max 200
  cursor?: Cursor;
}
export type ActivityResponse = Page<ActivityEvent>;

// GET /health → indexer liveness so the frontend can show chain-lag
export type IndexerStatus = 'healthy' | 'degraded' | 'stalled';

export interface HealthResponse {
  ok: boolean;
  chainId: number;
  indexedBlock: number;
  headBlock: number;
  lagBlocks: number;
  indexerStatus: IndexerStatus;
  lastSuccessfulPollAt: string | null;
  secondsSinceLastSuccessfulPoll: number | null;
}

// POST /markets/dedup-check
export interface DedupCheckRequest {
  question: string;
}

export interface DedupCheckResponse {
  available: boolean;
  isDuplicate: boolean;
  canonicalMarketId: string | null;
  candidates: DedupCandidate[];
}

/** Canonical path builders (single source; import in both tiers). */
export const routes = {
  siweNonce: () => `/auth/siwe/nonce`,
  siweVerify: () => `/auth/siwe/verify`,
  session: () => `/auth/session`,
  signOut: () => `/auth/sign-out`,
  accountProfile: () => `/account/profile`,
  accountWatchlist: (marketId: string) => `/account/watchlist/${marketId}`,
  accountBehavior: () => `/account/behavior`,
  markets: () => `/markets`,
  marketDedupCheck: () => `/markets/dedup-check`,
  market: (id: string) => `/markets/${id}`,
  marketBook: (id: string) => `/markets/${id}/book`,
  marketPrices: (id: string) => `/markets/${id}/prices`,
  truth: (marketId: string) => `/truth/${marketId}`,
  orderbook: (tokenId: string) => `/orderbook/${tokenId}`,
  account: (addr: string) => `/accounts/${addr}`,
  activity: () => `/activity`,
  config: () => `/config`,
  health: () => `/health`,
} as const;
