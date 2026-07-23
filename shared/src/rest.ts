// REST contract — paths + request params + response bodies.
// The backend implements these exactly; the frontend's api-client is generated from them.
// All amounts are raw strings per the units convention in domain.ts.

import type {
  Account,
  ActivityEvent,
  Market,
  MarketPhase,
  OrderBook,
  Pnl,
  Position,
  Resolution,
  Trade,
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

// GET /accounts/:addr
export interface AccountResponse {
  account: Account;
  positions: Position[];
  recentTrades: Trade[];
  pnl: Pnl;
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
export interface HealthResponse {
  ok: boolean;
  chainId: number;
  indexedBlock: number;
  headBlock: number;
  lagBlocks: number;
}

/** Canonical path builders (single source; import in both tiers). */
export const routes = {
  markets: () => `/markets`,
  market: (id: string) => `/markets/${id}`,
  marketBook: (id: string) => `/markets/${id}/book`,
  orderbook: (tokenId: string) => `/orderbook/${tokenId}`,
  account: (addr: string) => `/accounts/${addr}`,
  activity: () => `/activity`,
  health: () => `/health`,
} as const;
