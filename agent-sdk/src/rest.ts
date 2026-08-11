import {
  routes,
  type AccountResponse,
  type ActivityQuery,
  type ActivityResponse,
  type ConfigResponse,
  type DedupCheckRequest,
  type DedupCheckResponse,
  type HealthResponse,
  type IngestOrderRequest,
  type IngestOrderResponse,
  type ListMarketsQuery,
  type ListMarketsResponse,
  type MakerOrdersResponse,
  type MarketBookResponse,
  type MarketDetailResponse,
  type OrderBookResponse,
  type OrderIngestRejectionCode,
  type PriceHistoryQuery,
  type PriceHistoryResponse,
  type SessionResponse,
  type SiweNonceResponse,
  type SiweVerifyRequest,
  type TruthSignalResponse,
  type WithdrawOrderResponse,
} from '@predex-pump/shared/rest';

const DEFAULT_API_URL = 'http://localhost:3001';

type QueryValue = string | number | undefined;

interface RequestOptions {
  notFoundAsNull?: boolean;
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  sessionCookie?: string;
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
  postOrder(input: IngestOrderRequest): Promise<IngestOrderResponse>;
  getMyOrders(sessionCookie: string): Promise<MakerOrdersResponse>;
  getMakerOrders(sessionCookie: string): Promise<MakerOrdersResponse>;
  withdrawOrder(
    orderHash: string,
    sessionCookie: string,
  ): Promise<WithdrawOrderResponse>;
  getSiweNonce(): Promise<SiweNonceResponse>;
  verifySiwe(input: SiweVerifyRequest): Promise<SiweVerificationResult>;
  getSession(sessionCookie: string): Promise<SessionResponse>;
  getActivity(query?: ActivityQuery): Promise<ActivityResponse>;
  getConfig(): Promise<ConfigResponse>;
  getPriceHistory(
    marketId: string,
    query?: PriceHistoryQuery,
  ): Promise<PriceHistoryResponse>;
  getHealth(): Promise<HealthResponse>;
  getTruthSignal(marketId: string): Promise<TruthSignalResponse>;
}

export interface SiweVerificationResult {
  session: SessionResponse;
  /** Cookie request header value, without Set-Cookie attributes. */
  sessionCookie: string;
}

export class PredexRestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'PredexRestError';
    this.status = status;
    this.code = code;
  }
}

export class OrderIngestRejectedError extends PredexRestError {
  declare readonly code: OrderIngestRejectionCode;

  constructor(
    status: number,
    code: OrderIngestRejectionCode,
    message: string,
  ) {
    super(status, message, code);
    this.name = 'OrderIngestRejectedError';
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

const ORDER_INGEST_REJECTION_CODES = new Set<OrderIngestRejectionCode>([
  'MALFORMED_ORDER',
  'ORDER_HASH_MISMATCH',
  'BAD_SIGNATURE',
  'SIGNER_UNAUTHORIZED',
  'UNSUPPORTED_SIGNATURE_TYPE',
  'WRONG_NONCE',
  'EXPIRED',
  'INVALID_SIZE',
  'INVALID_PRICE',
  'PRICE_NOT_ON_TICK',
  'INVALID_FEE',
  'INVALID_TAKER',
  'MARKET_NOT_FOUND',
  'TOKEN_NOT_REGISTERED',
  'TOKEN_PAIR_MISMATCH',
  'MARKET_RESOLVED',
  'INSUFFICIENT_BALANCE',
  'MISSING_APPROVAL',
  'CHAIN_READ_FAILED',
]);

function isOrderIngestRejectionCode(
  value: unknown,
): value is OrderIngestRejectionCode {
  return (
    typeof value === 'string' &&
    ORDER_INGEST_REJECTION_CODES.has(value as OrderIngestRejectionCode)
  );
}

function errorDetails(body: unknown, status: number) {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body
  ) {
    if (typeof body.error === 'string') {
      return { message: body.error, code: undefined };
    }
    if (
      typeof body.error === 'object' &&
      body.error !== null &&
      'message' in body.error &&
      typeof body.error.message === 'string' &&
      'code' in body.error &&
      isOrderIngestRejectionCode(body.error.code)
    ) {
      return { message: body.error.message, code: body.error.code };
    }
  }
  return {
    message: `Backend request failed with HTTP ${status}.`,
    code: undefined,
  };
}

function sessionCookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie?.split(';', 1)[0]?.trim();
  if (!cookie || !cookie.includes('=')) {
    throw new Error('SIWE verification succeeded without a session cookie.');
  }
  return cookie;
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

  private async requestWithResponse<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ body: T; response: Response }> {
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (options.sessionCookie !== undefined) {
      headers.cookie = options.sessionCookie;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...(options.method === undefined ? {} : { method: options.method }),
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (response.status === 404 && options.notFoundAsNull) {
      return { body: null as T, response };
    }
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const details = errorDetails(body, response.status);
      if (details.code !== undefined) {
        throw new OrderIngestRejectedError(
          response.status,
          details.code,
          details.message,
        );
      }
      throw new PredexRestError(response.status, details.message);
    }
    return { body: (await response.json()) as T, response };
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    return (await this.requestWithResponse<T>(path, options)).body;
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

  postOrder(input: IngestOrderRequest) {
    return this.request<IngestOrderResponse>(routes.orders(), {
      method: 'POST',
      body: input,
    });
  }

  getMakerOrders(sessionCookie: string) {
    return this.request<MakerOrdersResponse>(routes.orders(), {
      sessionCookie,
    });
  }

  getMyOrders(sessionCookie: string) {
    return this.getMakerOrders(sessionCookie);
  }

  withdrawOrder(orderHash: string, sessionCookie: string) {
    return this.request<WithdrawOrderResponse>(
      routes.order(encodeURIComponent(orderHash)),
      { method: 'DELETE', sessionCookie },
    );
  }

  getSiweNonce() {
    return this.request<SiweNonceResponse>(routes.siweNonce(), {
      method: 'POST',
    });
  }

  async verifySiwe(input: SiweVerifyRequest): Promise<SiweVerificationResult> {
    const result = await this.requestWithResponse<SessionResponse>(
      routes.siweVerify(),
      { method: 'POST', body: input },
    );
    return {
      session: result.body,
      sessionCookie: sessionCookieFrom(result.response),
    };
  }

  getSession(sessionCookie: string) {
    return this.request<SessionResponse>(routes.session(), { sessionCookie });
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

  getTruthSignal(marketId: string) {
    return this.request<TruthSignalResponse>(
      routes.truth(encodeURIComponent(marketId)),
    );
  }
}

export function createRestClient(
  options: PredexRestClientOptions = {},
): PredexRestClient {
  return new FetchPredexRestClient(options);
}
