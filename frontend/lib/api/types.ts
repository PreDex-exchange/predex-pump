import type {
  AccountQuery,
  AccountResponse,
  AccountProfileResponse,
  ActivityQuery,
  ActivityResponse,
  ConfigResponse,
  DedupCheckRequest,
  DedupCheckResponse,
  ExchangeApprovalStateResponse,
  HealthResponse,
  GatewayBalanceResponse,
  ListMarketsQuery,
  ListMarketsResponse,
  MarketBookResponse,
  MarketDetailResponse,
  IngestOrderRequest,
  IngestOrderResponse,
  MakerOrdersResponse,
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

export interface ApiClient {
  listMarkets(query?: ListMarketsQuery): Promise<ListMarketsResponse>;
  dedupCheck(input: DedupCheckRequest): Promise<DedupCheckResponse>;
  getMarket(id: string): Promise<MarketDetailResponse | null>;
  getAccount(address: string, query?: AccountQuery): Promise<AccountResponse>;
  getOrderBook(
    marketId: string,
    query?: OrderBookQuery,
  ): Promise<MarketBookResponse>;
  getActivity(query?: ActivityQuery): Promise<ActivityResponse>;
  getConfig(): Promise<ConfigResponse>;
  getPriceHistory(
    marketId: string,
    query?: PriceHistoryQuery,
  ): Promise<PriceHistoryResponse>;
}

export interface BackendApiClient extends ApiClient {
  getTokenOrderBook(
    tokenId: string,
    query?: OrderBookQuery,
  ): Promise<OrderBookResponse>;
  getExchangeApprovals(
    address: string,
  ): Promise<ExchangeApprovalStateResponse>;
  getMyOrders(): Promise<MakerOrdersResponse>;
  postOrder(input: IngestOrderRequest): Promise<IngestOrderResponse>;
  withdrawOrder(orderHash: string): Promise<WithdrawOrderResponse>;
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
