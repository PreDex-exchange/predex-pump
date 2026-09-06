import type {
  AccountQuery,
  AccountResponse,
  AccountProfileResponse,
  ActivityQuery,
  ActivityResponse,
  DedupCheckRequest,
  DedupCheckResponse,
  ExchangeApprovalStateResponse,
  HealthResponse,
  GatewayBalanceResponse,
  ListMarketsQuery,
  ListMarketsResponse,
  IngestOrderRequest,
  IngestOrderResponse,
  MakerOrdersResponse,
  MarketBookResponse,
  MarketDetailResponse,
  OrderBookResponse,
  OrderBookQuery,
  PriceHistoryQuery,
  PriceHistoryResponse,
  RecordAccountBehaviorRequest,
  RecordAccountBehaviorResponse,
  SessionResponse,
  SiweNonceResponse,
  SiweVerifyRequest,
  UpdateAccountProfileRequest,
  WatchlistMutationResponse,
  WithdrawOrderResponse,
} from '@predex-pump/shared/rest';
import { routes } from '@predex-pump/shared/rest';

import type { BackendApiClient } from './types';
import {
  humanizeOrderRejection,
  isOrderIngestRejectionCode,
} from './order-errors';

const DEFAULT_API_URL = 'http://localhost:3001';
export const REST_READ_TIMEOUT_MS = 5_000;
export const REST_WRITE_TIMEOUT_MS = 10_000;

type QueryValue = string | number | undefined;

interface RequestOptions {
  notFoundAsNull?: boolean;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
}

interface ErrorDetails {
  message: string;
  code?: string;
}

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

function errorDetails(body: unknown, status: number): ErrorDetails {
  if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'code' in body.error &&
    isOrderIngestRejectionCode(body.error.code)
  ) {
    return {
      code: body.error.code,
      message: humanizeOrderRejection(body.error.code),
    };
  }
  if (status === 400) {
    return { message: 'The indexed API rejected this request.' };
  }
  if (status === 401) {
    return { message: 'Saved account features are not ready for this wallet.' };
  }
  if (status === 403) {
    return { message: 'The indexed API did not allow this request.' };
  }
  if (status === 404) {
    return { message: 'The requested indexed record was not found.' };
  }
  if (status === 409) {
    return { message: 'This request conflicted with newer indexed state.' };
  }
  if (status === 429) {
    return {
      message: 'The indexed API is busy. Wait a moment, then try again.',
    };
  }
  return { message: `The indexed API request failed with HTTP ${status}.` };
}

export const backendApiUrl = publicUrl(
  process.env.NEXT_PUBLIC_API_URL,
  DEFAULT_API_URL,
);

export class BackendApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'BackendApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const timeoutMs =
    options.timeoutMs ??
    (method === 'GET' ? REST_READ_TIMEOUT_MS : REST_WRITE_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  try {
    let response: Response;
    try {
      response = await fetch(`${backendApiUrl}${path}`, {
        cache: 'no-store',
        credentials: 'include',
        ...(options.method === undefined ? {} : { method: options.method }),
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw error;
      if (method === 'GET') {
        throw new Error(`The indexed API at ${backendApiUrl} could not be reached.`);
      }
      throw new Error(
        `The indexed API did not complete the ${method} request. The browser may have blocked this method, or the connection may have failed.`,
      );
    }

    if (response.status === 404 && options.notFoundAsNull) {
      return null as T;
    }
    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
        body = null;
      }
      const details = errorDetails(body, response.status);
      throw new BackendApiError(
        response.status,
        details.message,
        details.code,
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `The indexed API did not respond within ${timeoutMs / 1_000} seconds.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const backendRestClient: BackendApiClient = {
  getGatewayBalance(): Promise<GatewayBalanceResponse> {
    return request(routes.gatewayBalance());
  },

  getSiweNonce(): Promise<SiweNonceResponse> {
    return request(routes.siweNonce(), { method: 'POST' });
  },

  verifySiwe(input: SiweVerifyRequest): Promise<SessionResponse> {
    return request(routes.siweVerify(), { method: 'POST', body: input });
  },

  getSession(): Promise<SessionResponse> {
    return request(routes.session());
  },

  signOut(): Promise<SessionResponse> {
    return request(routes.signOut(), { method: 'POST' });
  },

  getAccountProfile(): Promise<AccountProfileResponse> {
    return request(routes.accountProfile());
  },

  updateAccountProfile(
    input: UpdateAccountProfileRequest,
  ): Promise<AccountProfileResponse> {
    return request(routes.accountProfile(), { method: 'PATCH', body: input });
  },

  setWatchlist(
    marketId: string,
    watchlisted: boolean,
  ): Promise<WatchlistMutationResponse> {
    return request(routes.accountWatchlist(encodeURIComponent(marketId)), {
      method: watchlisted ? 'PUT' : 'DELETE',
    });
  },

  recordAccountBehavior(
    input: RecordAccountBehaviorRequest,
  ): Promise<RecordAccountBehaviorResponse> {
    return request(routes.accountBehavior(), { method: 'POST', body: input });
  },

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

  dedupCheck(input: DedupCheckRequest): Promise<DedupCheckResponse> {
    return request(routes.marketDedupCheck(), {
      method: 'POST',
      body: input,
    });
  },

  getMarket(id: string): Promise<MarketDetailResponse | null> {
    return request(routes.market(encodeURIComponent(id)), {
      notFoundAsNull: true,
    });
  },

  getAccount(
    address: string,
    query: AccountQuery = {},
  ): Promise<AccountResponse> {
    return request(
      withQuery(routes.account(encodeURIComponent(address)), {
        marketId: query.marketId,
        positionsLimit: query.positionsLimit,
        positionsCursor: query.positionsCursor,
      }),
    );
  },

  getExchangeApprovals(
    address: string,
  ): Promise<ExchangeApprovalStateResponse> {
    return request(
      routes.exchangeApprovals(encodeURIComponent(address)),
    );
  },

  getMyOrders(): Promise<MakerOrdersResponse> {
    return request(routes.orders());
  },

  postOrder(input: IngestOrderRequest): Promise<IngestOrderResponse> {
    return request(routes.orders(), { method: 'POST', body: input });
  },

  withdrawOrder(orderHash: string): Promise<WithdrawOrderResponse> {
    return request(routes.order(encodeURIComponent(orderHash)), {
      method: 'DELETE',
    });
  },

  getOrderBook(
    marketId: string,
    query: OrderBookQuery = {},
  ): Promise<MarketBookResponse> {
    return request(
      withQuery(routes.marketBook(encodeURIComponent(marketId)), {
        orderLimitPerSide: query.orderLimitPerSide,
      }),
    );
  },

  getTokenOrderBook(
    tokenId: string,
    query: OrderBookQuery = {},
  ): Promise<OrderBookResponse> {
    return request(
      withQuery(routes.orderbook(encodeURIComponent(tokenId)), {
        orderLimitPerSide: query.orderLimitPerSide,
      }),
    );
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
