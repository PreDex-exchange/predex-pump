import type {
  AccountResponse,
  AccountProfileResponse,
  ActivityQuery,
  ActivityResponse,
  ConfigResponse,
  DedupCheckRequest,
  DedupCheckResponse,
  HealthResponse,
  GatewayBalanceResponse,
  ListMarketsQuery,
  ListMarketsResponse,
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
} from '@predex-pump/shared/rest';

export interface ApiClient {
  listMarkets(query?: ListMarketsQuery): Promise<ListMarketsResponse>;
  dedupCheck(input: DedupCheckRequest): Promise<DedupCheckResponse>;
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
  getGatewayBalance(): Promise<GatewayBalanceResponse>;
  getSiweNonce(): Promise<SiweNonceResponse>;
  verifySiwe(input: SiweVerifyRequest): Promise<SessionResponse>;
  getSession(): Promise<SessionResponse>;
  signOut(): Promise<SessionResponse>;
  getAccountProfile(): Promise<AccountProfileResponse>;
  updateAccountProfile(
    input: UpdateAccountProfileRequest,
  ): Promise<AccountProfileResponse>;
  setWatchlist(
    marketId: string,
    watchlisted: boolean,
  ): Promise<WatchlistMutationResponse>;
  recordAccountBehavior(
    input: RecordAccountBehaviorRequest,
  ): Promise<RecordAccountBehaviorResponse>;
}
