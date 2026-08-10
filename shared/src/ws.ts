// WebSocket contract — channels + message envelopes.
// The backend pushes an update on each indexed event; the frontend subscribes per view
// so writes-to-chain reflect back without manual refetch.

import type {
  ActivityEvent,
  Fill,
  Market,
  OffchainOrder,
  Order,
  Position,
  Resolution,
  Trade,
} from './domain';

// ── Channels ─────────────────────────────────────────────────────────────────────
// 'markets'          global feed: new + graduated + phase changes
// 'market:<id>'      one market: price ticks, trades, graduation
// 'book:<marketId>'  that market's order book: place / fill / cancel / seed
// 'account:<addr>'   one account: position + trade updates
// 'activity'         global activity timeline
export type Channel =
  | 'markets'
  | `market:${string}`
  | `book:${string}`
  | `account:${string}`
  | 'activity';

// ── Client → server ────────────────────────────────────────────────────────────────
export interface SubscribeMessage {
  type: 'subscribe' | 'unsubscribe';
  channels: Channel[];
}

// ── Server → client ────────────────────────────────────────────────────────────────
export type ServerEvent =
  | { channel: 'markets'; event: 'market.created'; data: Market }
  | { channel: 'markets'; event: 'market.updated'; data: Market }
  | { channel: 'markets'; event: 'market.graduated'; data: Market }
  | { channel: `market:${string}`; event: 'price.tick'; data: { marketId: string; yesPriceRaw: string; noPriceRaw: string; ts: number } }
  | { channel: `market:${string}`; event: 'trade'; data: Trade }
  | { channel: `market:${string}`; event: 'graduated'; data: Market }
  | { channel: `market:${string}`; event: 'resolution'; data: Resolution }
  | { channel: `book:${string}`; event: 'order.placed'; data: Order }
  | { channel: `book:${string}`; event: 'order.filled'; data: Fill }
  | { channel: `book:${string}`; event: 'order.cancelled'; data: Order }
  | { channel: `book:${string}`; event: 'book.seeded'; data: { marketId: string; orders: Order[] } }
  | { channel: `book:${string}`; event: 'offchain.order.placed'; data: OffchainOrder }
  | { channel: `book:${string}`; event: 'offchain.order.withdrawn'; data: OffchainOrder }
  | { channel: `book:${string}`; event: 'book.updated'; data: { marketId: string; reason: 'FILLABILITY_CHANGED' | 'EXCHANGE_EVENT' } }
  | { channel: `account:${string}`; event: 'position.updated'; data: Position }
  | { channel: `account:${string}`; event: 'trade'; data: Trade }
  | { channel: 'activity'; event: 'activity'; data: ActivityEvent };

/** Envelope every server push is wrapped in. */
export interface ServerMessage {
  type: 'update';
  channel: Channel;
  event: string;
  data: unknown;
  ts: number;
}

export type WsInbound = SubscribeMessage;
export type WsOutbound = ServerMessage | { type: 'ack'; channels: Channel[] } | { type: 'error'; message: string };
