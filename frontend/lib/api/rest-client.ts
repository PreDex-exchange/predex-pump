import type {
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

type QueryValue = string | number | undefined;

interface RequestOptions {
  notFoundAsNull?: boolean;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
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
    typeof body.error === 'string'
  ) {
    return { message: body.error };
  }
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
  return { message: `Backend request failed with HTTP ${status}.` };
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
  let response: Response;
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  try {
    response = await fetch(`${backendApiUrl}${path}`, {
      cache: 'no-store',
      credentials: 'include',
      ...(options.method === undefined ? {} : { method: options.method }),
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  } catch {
    const method = options.method ?? 'GET';
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
    } catch {
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

  getAccount(address: string): Promise<AccountResponse> {
    return request(routes.account(encodeURIComponent(address)));
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
