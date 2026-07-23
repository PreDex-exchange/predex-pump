import type {
  AccountResponse,
  ActivityQuery,
  ActivityResponse,
  ConfigResponse,
  ListMarketsQuery,
  ListMarketsResponse,
  MarketBookResponse,
  MarketDetailResponse,
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
