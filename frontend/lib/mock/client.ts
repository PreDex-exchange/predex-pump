import type { AccountResponse, MarketBookResponse } from '@predex-pump/shared/rest';

import type { ApiClient } from '@/lib/api/types';

import {
  MOCK_ACCOUNT_RESPONSE,
  MOCK_ACTIVITY,
  MOCK_CONFIG,
  MOCK_MARKETS,
  MOCK_ORDER_BOOKS,
  MOCK_PRICE_HISTORY,
  MOCK_RESOLUTIONS,
  MOCK_TRADES,
} from './data';

const MOCK_DELAY_MS = 90;

async function respond<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS));
  return value;
}

function emptyBookResponse(marketId: string): MarketBookResponse {
  const market = MOCK_MARKETS.find((item) => item.id === marketId);
  if (!market) {
    throw new Error(`Unknown mock market: ${marketId}`);
  }

  return {
    marketId,
    yes: {
      marketId,
      outcome: 'YES',
      tokenId: market.yesTokenId,
      bids: [],
      asks: [],
      orders: [],
    },
    no: {
      marketId,
      outcome: 'NO',
      tokenId: market.noTokenId,
      bids: [],
      asks: [],
      orders: [],
    },
  };
}

export const mockApiClient: ApiClient = {
  async listMarkets(query = {}) {
    let items = [...MOCK_MARKETS];

    if (query.phase) items = items.filter((market) => market.phase === query.phase);
    if (query.creator) {
      items = items.filter(
        (market) => market.creator.toLowerCase() === query.creator?.toLowerCase(),
      );
    }

    const limit = Math.min(query.limit ?? 50, 200);
    return respond({
      items: items.slice(0, limit),
      nextCursor: items.length > limit ? `mock:${limit}` : null,
    });
  },

  async getMarket(id) {
    const market = MOCK_MARKETS.find((item) => item.id === id);
    if (!market) return respond(null);

    return respond({
      market,
      recentTrades: MOCK_TRADES.filter((trade) => trade.marketId === id),
      resolution: MOCK_RESOLUTIONS[id] ?? null,
    });
  },

  async getAccount(address) {
    const normalizedAddress = address.toLowerCase() as AccountResponse['account']['address'];
    return respond({
      ...MOCK_ACCOUNT_RESPONSE,
      account: {
        ...MOCK_ACCOUNT_RESPONSE.account,
        address: normalizedAddress,
      },
      positions: MOCK_ACCOUNT_RESPONSE.positions.map((position) => ({
        ...position,
        account: normalizedAddress,
      })),
    });
  },

  async getOrderBook(marketId) {
    return respond(MOCK_ORDER_BOOKS[marketId] ?? emptyBookResponse(marketId));
  },

  async getActivity(query = {}) {
    let items = [...MOCK_ACTIVITY];
    if (query.marketId) items = items.filter((event) => event.marketId === query.marketId);
    if (query.account) {
      items = items.filter(
        (event) => event.account?.toLowerCase() === query.account?.toLowerCase(),
      );
    }

    const limit = Math.min(query.limit ?? 50, 200);
    return respond({
      items: items.slice(0, limit),
      nextCursor: items.length > limit ? `mock:${limit}` : null,
    });
  },

  async getConfig() {
    return respond(MOCK_CONFIG);
  },

  async getPriceHistory(marketId, query = {}) {
    let points = [...(MOCK_PRICE_HISTORY[marketId] ?? [])];
    if (query.fromTs) points = points.filter((point) => point.ts >= (query.fromTs ?? 0));
    const limit = Math.min(query.limit ?? 500, 2_000);

    return respond({
      marketId,
      points: points.slice(-limit),
    });
  },
};
