import type {
  AccountResponse,
  ActivityQuery,
  ActivityResponse,
  ConfigResponse,
  HealthResponse,
  ListMarketsQuery,
  ListMarketsResponse,
  MarketBookResponse,
  MarketDetailResponse,
  OrderBookResponse,
  PriceHistoryQuery,
  PriceHistoryResponse,
} from '@predex-pump/shared/rest';

export interface ApiClient {
  listMarkets(query?: ListMarketsQuery): Promise<ListMarketsResponse>;
  getMarket(id: string): Promise<MarketDetailResponse | null>;
  getAccount(address: string): Promise<AccountResponse>;
  getOrderBook(marketId: string): Promise<MarketBookResponse>;
  getActivity(query?: ActivityQuery): Promise<ActivityResponse>;
  getConfig(): Promise<ConfigResponse>;
  getPriceHistory(
    marketId: string,
    query?: PriceHistoryQuery,
  ): Promise<PriceHistoryResponse>;
}

export interface BackendApiClient extends ApiClient {
  getTokenOrderBook(tokenId: string): Promise<OrderBookResponse>;
  getHealth(): Promise<HealthResponse>;
}
