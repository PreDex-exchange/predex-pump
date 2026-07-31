import {
  routes,
  type AccountResponse,
  type ActivityQuery,
  type ActivityResponse,
  type ConfigResponse,
  type DedupCheckRequest,
  type DedupCheckResponse,
  type HealthResponse,
  type ListMarketsQuery,
  type ListMarketsResponse,
  type MarketBookResponse,
  type MarketDetailResponse,
  type OrderBookResponse,
  type PriceHistoryQuery,
  type PriceHistoryResponse,
} from '@predex-pump/shared/rest';

const DEFAULT_API_URL = 'http://localhost:3001';

type QueryValue = string | number | undefined;

interface RequestOptions {
  notFoundAsNull?: boolean;
  method?: 'GET' | 'POST';
  body?: unknown;
}

export interface PredexRestClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export interface PredexRestClient {
  listMarkets(query?: ListMarketsQuery): Promise<ListMarketsResponse>;
  dedupCheck(input: DedupCheckRequest): Promise<DedupCheckResponse>;
  getMarket(id: string): Promise<MarketDetailResponse | null>;
  getAccount(address: string): Promise<AccountResponse>;
  getOrderBook(marketId: string): Promise<MarketBookResponse>;
  getTokenOrderBook(tokenId: string): Promise<OrderBookResponse>;
  getActivity(query?: ActivityQuery): Promise<ActivityResponse>;
  getConfig(): Promise<ConfigResponse>;
  getPriceHistory(
    marketId: string,
    query?: PriceHistoryQuery,
  ): Promise<PriceHistoryResponse>;
  getHealth(): Promise<HealthResponse>;
}

export class PredexRestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'PredexRestError';
    this.status = status;
  }
}

function normalizeBaseUrl(value: string | undefined) {
  return (value?.trim() || DEFAULT_API_URL).replace(/\/+$/u, '');
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

class FetchPredexRestClient implements PredexRestClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: PredexRestClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error('A fetch implementation is required.');
    }
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...(options.method === undefined ? {} : { method: options.method }),
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
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
      throw new PredexRestError(
        response.status,
        errorMessage(body, response.status),
      );
    }
    return (await response.json()) as T;
  }

  listMarkets(query: ListMarketsQuery = {}) {
    return this.request<ListMarketsResponse>(
      withQuery(routes.markets(), {
        phase: query.phase,
        creator: query.creator,
        limit: query.limit,
        cursor: query.cursor,
      }),
    );
  }

  async dedupCheck(input: DedupCheckRequest) {
    try {
      return await this.request<DedupCheckResponse>(
        routes.marketDedupCheck(),
        {
          method: 'POST',
          body: input,
        },
      );
    } catch {
      // Dedup is advisory. A transport or backend failure must never become a
      // market-creation gate for SDK callers.
      return {
        available: false,
        isDuplicate: false,
        canonicalMarketId: null,
        candidates: [],
      };
    }
  }

  getMarket(id: string) {
    return this.request<MarketDetailResponse | null>(
      routes.market(encodeURIComponent(id)),
      { notFoundAsNull: true },
    );
  }

  getAccount(address: string) {
    return this.request<AccountResponse>(
      routes.account(encodeURIComponent(address)),
    );
  }

  getOrderBook(marketId: string) {
    return this.request<MarketBookResponse>(
      routes.marketBook(encodeURIComponent(marketId)),
    );
  }

  getTokenOrderBook(tokenId: string) {
    return this.request<OrderBookResponse>(
      routes.orderbook(encodeURIComponent(tokenId)),
    );
  }

  getActivity(query: ActivityQuery = {}) {
    return this.request<ActivityResponse>(
      withQuery(routes.activity(), {
        marketId: query.marketId,
        account: query.account,
        limit: query.limit,
        cursor: query.cursor,
      }),
    );
  }

  getConfig() {
    return this.request<ConfigResponse>(routes.config());
  }

  getPriceHistory(marketId: string, query: PriceHistoryQuery = {}) {
    return this.request<PriceHistoryResponse>(
      withQuery(routes.marketPrices(encodeURIComponent(marketId)), {
        fromTs: query.fromTs,
        limit: query.limit,
      }),
    );
  }

  getHealth() {
    return this.request<HealthResponse>(routes.health());
  }
}

export function createRestClient(
  options: PredexRestClientOptions = {},
): PredexRestClient {
  return new FetchPredexRestClient(options);
}
