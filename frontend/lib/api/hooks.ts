'use client';

import type {
  AccountResponse,
  AccountProfileResponse,
  ActivityQuery,
  ActivityResponse,
  DedupCheckResponse,
  ExchangeApprovalStateResponse,
  HealthResponse,
  GatewayBalanceResponse,
  ListMarketsQuery,
  ListMarketsResponse,
  MarketBookResponse,
  MarketDetailResponse,
  MakerOrdersResponse,
  PriceHistoryQuery,
  PriceHistoryResponse,
  VenueTransition,
} from '@predex-pump/shared/rest';
import type {
  Outcome,
  Position,
  RegistryConfig,
} from '@predex-pump/shared/domain';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  backendRestClient as apiClient,
  REST_READ_TIMEOUT_MS,
} from './rest-client';
import {
  backendWsClient,
  type BackendConnectionStatus,
} from './websocket';

const MARKET_BACKGROUND_REFRESH_MS = 60_000;
const MARKET_DETAIL_FALLBACK_REFRESH_MS = 15_000;
const ORDER_BOOK_TRANSITION_REFRESH_MS = 2_000;
const ORDER_BOOK_LIVE_REFRESH_MS = 15_000;
const ORDER_BOOK_FALLBACK_REFRESH_MS = 4_000;
const HEALTH_REFRESH_MS = 15_000;
export const MARKET_DETAIL_RETRY_COUNT = 3;
const API_RETRY_BASE_DELAY_MS = 1_000;
const API_RETRY_MAX_DELAY_MS = 30_000;
export const MARKET_DETAIL_FAILURE_DISCLOSURE_OVERHEAD_MS = 3_000;
export const DEDUP_CHECK_DEBOUNCE_MS = 500;

export function apiRetryDelayMs(failureCount: number) {
  return Math.min(
    API_RETRY_BASE_DELAY_MS * 2 ** failureCount,
    API_RETRY_MAX_DELAY_MS,
  );
}

export const MARKET_DETAIL_MAX_FAILURE_DISCLOSURE_MS =
  REST_READ_TIMEOUT_MS * (MARKET_DETAIL_RETRY_COUNT + 1) +
  Array.from(
    { length: MARKET_DETAIL_RETRY_COUNT },
    (_, failureCount) => apiRetryDelayMs(failureCount),
  ).reduce((total, delay) => total + delay, 0) +
  // Browser measurement found 2,022 ms beyond the nominal request/retry
  // schedule. Round that timer/observer/render overhead up to a whole second.
  MARKET_DETAIL_FAILURE_DISCLOSURE_OVERHEAD_MS;

export function orderBookRefreshIntervalMs(
  connectionStatus: BackendConnectionStatus,
  book?: {
    liveVenue: string;
    orderBookAvailable: boolean;
    venueTransition?: VenueTransition;
  },
) {
  if (
    book?.venueTransition?.state === 'PREPARING' ||
    (book?.orderBookAvailable === true && book.liveVenue === 'MINICLOB')
  ) {
    return ORDER_BOOK_TRANSITION_REFRESH_MS;
  }
  return connectionStatus === 'live'
    ? ORDER_BOOK_LIVE_REFRESH_MS
    : ORDER_BOOK_FALLBACK_REFRESH_MS;
}

interface ResourceState<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  isSuccess: boolean;
  refetch: () => void;
}

interface ResourceOptions<T> {
  refetchInterval?: UseQueryOptions<T, Error>['refetchInterval'];
  refetchOnWindowFocus?: boolean | 'always';
  enabled?: boolean;
  retry?: boolean | number;
  retryDelay?: number | ((failureCount: number, error: Error) => number);
}

interface QueryResourceStatus {
  data: unknown;
  error: Error | null;
  failureReason: Error | null;
  isFetched: boolean;
  isLoading: boolean;
  isPaused: boolean;
}

const RETAINED_QUERY_ERROR = new Error(
  'The indexed API request is still unavailable.',
);

function stableResourceStatus(query: QueryResourceStatus) {
  const error =
    query.error ??
    (query.data === undefined
      ? query.isPaused
        ? (query.failureReason ?? RETAINED_QUERY_ERROR)
        : query.isFetched
          ? RETAINED_QUERY_ERROR
          : null
      : null);
  return {
    error,
    isLoading: query.isLoading && error === null,
  };
}

function useApiResource<T>(
  queryKey: QueryKey,
  load: () => Promise<T>,
  options: ResourceOptions<T> = {},
): ResourceState<T> {
  const query = useQuery<T, Error>({
    queryKey,
    queryFn: load,
    staleTime: 30_000,
    refetchInterval: options.refetchInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: options.refetchOnWindowFocus,
    enabled: options.enabled,
    retry: options.retry,
    retryDelay: options.retryDelay,
  });
  const status = stableResourceStatus(query);

  return {
    data: query.data ?? null,
    isLoading: status.isLoading,
    error: status.error,
    isSuccess: query.isSuccess,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useMarkets(query: ListMarketsQuery = {}) {
  const { phase, creator, limit, cursor } = query;
  const result = useInfiniteQuery({
    queryKey: ['markets', phase, creator, limit, cursor, 'paginated'],
    queryFn: ({ pageParam }) =>
      apiClient.listMarkets({
        phase,
        creator,
        limit,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    initialPageParam: cursor,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
    refetchInterval: MARKET_BACKGROUND_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
  const status = stableResourceStatus(result);
  const data = useMemo<ListMarketsResponse | null>(() => {
    if (!result.data) return null;
    const pages = result.data.pages;
    return {
      items: pages.flatMap((page) => page.items),
      nextCursor: pages[pages.length - 1]?.nextCursor ?? null,
    };
  }, [result.data]);

  return {
    data,
    isLoading: status.isLoading,
    isLoadingMore: result.isFetchingNextPage,
    error: status.error,
    hasNextPage: result.hasNextPage,
    loadMore: () => {
      void result.fetchNextPage();
    },
    refetch: () => {
      void result.refetch();
    },
  };
}

export function useDedupCheck(
  question: string,
  debounceMs = DEDUP_CHECK_DEBOUNCE_MS,
): ResourceState<DedupCheckResponse> {
  const normalizedQuestion = question.trim();
  const [debouncedQuestion, setDebouncedQuestion] = useState('');

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedQuestion(normalizedQuestion);
    }, normalizedQuestion ? debounceMs : 0);
    return () => window.clearTimeout(timeout);
  }, [debounceMs, normalizedQuestion]);

  const query = useQuery<DedupCheckResponse, Error>({
    queryKey: ['dedup-check', debouncedQuestion],
    queryFn: () =>
      apiClient.dedupCheck({ question: debouncedQuestion }),
    enabled: debouncedQuestion.length > 0,
    retry: false,
    staleTime: 30_000,
  });
  const isCurrent = normalizedQuestion === debouncedQuestion;
  const isPending =
    normalizedQuestion.length > 0 && (!isCurrent || query.isFetching);
  const status = stableResourceStatus(query);

  return {
    data: isCurrent ? (query.data ?? null) : null,
    isLoading: isPending && (!isCurrent || status.error === null),
    error: isCurrent ? status.error : null,
    isSuccess: isCurrent && query.isSuccess,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useMarket(id: string) {
  const queryClient = useQueryClient();
  const load = useCallback(() => apiClient.getMarket(id), [id]);
  useEffect(() => {
    if (!id) return;
    return backendWsClient.subscribe(`market:${id}`, () => {
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: ['market', id],
      });
    });
  }, [id, queryClient]);

  const resource = useApiResource<MarketDetailResponse | null>(
    ['market', id],
    load,
    {
      refetchInterval: MARKET_DETAIL_FALLBACK_REFRESH_MS,
      retry: MARKET_DETAIL_RETRY_COUNT,
      retryDelay: apiRetryDelayMs,
    },
  );
  return {
    ...resource,
    isNotFound: resource.isSuccess && resource.data === null,
  };
}

export function useAccount(address?: string) {
  const queryClient = useQueryClient();
  const normalizedAddress = address?.toLowerCase();
  const load = useCallback(
    () => (address ? apiClient.getAccount(address) : Promise.resolve(null)),
    [address],
  );
  useEffect(() => {
    if (!normalizedAddress) return;
    return backendWsClient.subscribe(
      `account:${normalizedAddress}`,
      () => {
        void queryClient.invalidateQueries({
          exact: true,
          queryKey: ['account', address],
        });
      },
    );
  }, [address, normalizedAddress, queryClient]);

  return useApiResource<AccountResponse | null>(['account', address], load);
}

export function useExchangeApprovals(address?: string) {
  const normalizedAddress = address?.toLowerCase();
  const load = useCallback(
    () =>
      normalizedAddress
        ? apiClient.getExchangeApprovals(normalizedAddress)
        : Promise.resolve(null),
    [normalizedAddress],
  );
  return useApiResource<ExchangeApprovalStateResponse | null>(
    ['exchange-approvals', normalizedAddress],
    load,
    {
      enabled: Boolean(normalizedAddress),
      refetchInterval: 15_000,
    },
  );
}

export function useMyOrders(address?: string, enabled = true) {
  const normalizedAddress = address?.toLowerCase();
  const load = useCallback(() => apiClient.getMyOrders(), []);
  return useApiResource<MakerOrdersResponse>(['my-orders', normalizedAddress], load, {
    enabled: enabled && Boolean(normalizedAddress),
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useAccountProfile(enabled = true) {
  const load = useCallback(() => apiClient.getAccountProfile(), []);
  return useApiResource<AccountProfileResponse>(['account-profile'], load, {
    enabled,
  });
}

export function useGatewayBalance(enabled = true) {
  const load = useCallback(() => apiClient.getGatewayBalance(), []);
  const query = useQuery<GatewayBalanceResponse, Error>({
    queryKey: ['gateway-balance'],
    queryFn: load,
    enabled,
    retry: false,
    staleTime: 10_000,
  });
  const status = stableResourceStatus(query);
  return {
    data: query.data ?? null,
    isLoading: status.isLoading,
    error: status.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function usePosition(
  address: string | undefined,
  marketId: string,
  outcome?: Outcome,
): ResourceState<Position> {
  const account = useAccount(address);
  const position =
    account.data?.positions.find(
      (item) =>
        item.marketId === marketId && (outcome === undefined || item.outcome === outcome),
    ) ?? null;

  return {
    ...account,
    data: position,
  };
}

export function useOrderBook(marketId: string) {
  const queryClient = useQueryClient();
  const [connectionStatus, setConnectionStatus] =
    useState<BackendConnectionStatus>('idle');
  const load = useCallback(() => apiClient.getOrderBook(marketId), [marketId]);
  useEffect(() => {
    if (!marketId || marketId === 'preview') return;
    return backendWsClient.subscribe(`book:${marketId}`, () => {
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: ['order-book', marketId],
      });
    });
  }, [marketId, queryClient]);
  useEffect(
    () => backendWsClient.subscribeStatus(setConnectionStatus),
    [],
  );

  return useApiResource<MarketBookResponse>(['order-book', marketId], load, {
    refetchInterval: (query) =>
      orderBookRefreshIntervalMs(connectionStatus, query.state.data),
    refetchOnWindowFocus: 'always',
  });
}

export function useActivity(query: ActivityQuery = {}) {
  const { marketId, account, limit, cursor } = query;
  const result = useInfiniteQuery({
    queryKey: ['activity', marketId, account, limit, cursor, 'paginated'],
    queryFn: ({ pageParam }) =>
      apiClient.getActivity({
        marketId,
        account,
        limit,
        ...(pageParam === undefined ? {} : { cursor: pageParam }),
      }),
    initialPageParam: cursor,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  });
  const status = stableResourceStatus(result);
  const data = useMemo<ActivityResponse | null>(() => {
    if (!result.data) return null;
    const pages = result.data.pages;
    return {
      items: pages.flatMap((page) => page.items),
      nextCursor: pages[pages.length - 1]?.nextCursor ?? null,
    };
  }, [result.data]);

  return {
    data,
    isLoading: status.isLoading,
    isLoadingMore: result.isFetchingNextPage,
    error: status.error,
    hasNextPage: result.hasNextPage,
    loadMore: () => {
      void result.fetchNextPage();
    },
    refetch: () => {
      void result.refetch();
    },
  };
}

export function useConfig() {
  const load = useCallback(() => apiClient.getConfig(), []);
  return useApiResource<RegistryConfig>(['config'], load, { retry: false });
}

export function usePriceHistory(marketId: string, query: PriceHistoryQuery = {}) {
  const queryClient = useQueryClient();
  const { fromTs, limit } = query;
  const load = useCallback(
    () =>
      marketId === 'preview'
        ? Promise.resolve({ marketId, points: [] })
        : apiClient.getPriceHistory(marketId, { fromTs, limit }),
    [fromTs, limit, marketId],
  );
  useEffect(() => {
    if (!marketId || marketId === 'preview') return;
    return backendWsClient.subscribe(`market:${marketId}`, (message) => {
      if (message.event !== 'price.tick') return;
      void queryClient.invalidateQueries({
        queryKey: ['price-history', marketId],
      });
    });
  }, [marketId, queryClient]);

  return useApiResource<PriceHistoryResponse>(
    ['price-history', marketId, fromTs, limit],
    load,
  );
}

export function useHealth() {
  const load = useCallback(() => apiClient.getHealth(), []);
  return useApiResource<HealthResponse>(['health'], load, {
    refetchInterval: HEALTH_REFRESH_MS,
  });
}
