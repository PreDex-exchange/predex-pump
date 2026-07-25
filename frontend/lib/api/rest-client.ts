import type {
  AccountResponse,
  ActivityQuery,
  ActivityResponse,
  HealthResponse,
  ListMarketsQuery,
  ListMarketsResponse,
  MarketBookResponse,
  MarketDetailResponse,
  OrderBookResponse,
  PriceHistoryQuery,
  PriceHistoryResponse,
} from '@predex-pump/shared/rest';
import { routes } from '@predex-pump/shared/rest';

import type { BackendApiClient } from './types';

const DEFAULT_API_URL = 'http://localhost:3001';

type QueryValue = string | number | undefined;

function publicUrl(value: string | undefined, fallback: string) {
  const normalized = value?.trim() || fallback;
  return normalized.replace(/\/+$/u, '');
}

function withQuery(path: string, query: Record<string, QueryValue>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function errorMessage(body: unknown, status: number) {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string'
  ) {
    return body.error;
  }
  return `Backend request failed with HTTP ${status}.`;
}

export const backendApiUrl = publicUrl(
  process.env.NEXT_PUBLIC_API_URL,
  DEFAULT_API_URL,
);

export class BackendApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'BackendApiError';
    this.status = status;
  }
}

async function request<T>(
  path: string,
  options: { notFoundAsNull?: boolean } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${backendApiUrl}${path}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new Error(`The indexed API at ${backendApiUrl} could not be reached.`);
  }

  if (response.status === 404 && options.notFoundAsNull) {
    return null as T;
  }
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw new BackendApiError(response.status, errorMessage(body, response.status));
  }

  return (await response.json()) as T;
}

export const backendRestClient: BackendApiClient = {
  listMarkets(query: ListMarketsQuery = {}): Promise<ListMarketsResponse> {
    return request(
      withQuery(routes.markets(), {
        phase: query.phase,
        creator: query.creator,
        limit: query.limit,
        cursor: query.cursor,
      }),
    );
  },

  getMarket(id: string): Promise<MarketDetailResponse | null> {
    return request(routes.market(encodeURIComponent(id)), {
      notFoundAsNull: true,
    });
  },

  getAccount(address: string): Promise<AccountResponse> {
    return request(routes.account(encodeURIComponent(address)));
  },

  getOrderBook(marketId: string): Promise<MarketBookResponse> {
    return request(routes.marketBook(encodeURIComponent(marketId)));
  },

  getTokenOrderBook(tokenId: string): Promise<OrderBookResponse> {
    return request(routes.orderbook(encodeURIComponent(tokenId)));
  },

  getActivity(query: ActivityQuery = {}): Promise<ActivityResponse> {
    return request(
      withQuery(routes.activity(), {
        marketId: query.marketId,
        account: query.account,
        limit: query.limit,
        cursor: query.cursor,
      }),
    );
  },

  getConfig() {
    return request(routes.config());
  },

  getPriceHistory(
    marketId: string,
    query: PriceHistoryQuery = {},
  ): Promise<PriceHistoryResponse> {
    return request(
      withQuery(routes.marketPrices(encodeURIComponent(marketId)), {
        fromTs: query.fromTs,
        limit: query.limit,
      }),
    );
  },

  getHealth(): Promise<HealthResponse> {
    return request(routes.health());
  },
};
