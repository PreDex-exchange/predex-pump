'use client';

import type {
  AccountResponse,
  AccountProfileResponse,
  ActivityQuery,
  ActivityResponse,
  DedupCheckResponse,
  HealthResponse,
  GatewayBalanceResponse,
  ListMarketsQuery,
  ListMarketsResponse,
  MarketBookResponse,
  MarketDetailResponse,
  PriceHistoryQuery,
  PriceHistoryResponse,
} from '@predex-pump/shared/rest';
import type {
  Outcome,
  Position,
  RegistryConfig,
} from '@predex-pump/shared/domain';
import {
  useQuery,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';

import { backendRestClient as apiClient } from './rest-client';
import { backendWsClient } from './websocket';

const MARKET_BACKGROUND_REFRESH_MS = 60_000;
const MARKET_DETAIL_FALLBACK_REFRESH_MS = 15_000;
const HEALTH_REFRESH_MS = 15_000;
export const DEDUP_CHECK_DEBOUNCE_MS = 500;

interface ResourceState<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

interface ResourceOptions {
  refetchInterval?: number;
  enabled?: boolean;
}

function useApiResource<T>(
  queryKey: QueryKey,
  load: () => Promise<T>,
  options: ResourceOptions = {},
): ResourceState<T> {
  const query = useQuery<T, Error>({
    queryKey,
    queryFn: load,
    staleTime: 30_000,
    refetchInterval: options.refetchInterval,
    refetchIntervalInBackground: false,
    enabled: options.enabled,
  });

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useMarkets(query: ListMarketsQuery = {}) {
  const { phase, creator, limit, cursor } = query;
  const load = useCallback(
    () => apiClient.listMarkets({ phase, creator, limit, cursor }),
    [creator, cursor, limit, phase],
  );
  return useApiResource<ListMarketsResponse>(
    ['markets', phase, creator, limit, cursor],
    load,
    { refetchInterval: MARKET_BACKGROUND_REFRESH_MS },
  );
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

  return {
    data: isCurrent ? (query.data ?? null) : null,
    isLoading: isCurrent && query.isLoading,
    error: isCurrent ? query.error : null,
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

  return useApiResource<MarketDetailResponse | null>(['market', id], load, {
    refetchInterval: MARKET_DETAIL_FALLBACK_REFRESH_MS,
  });
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
  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
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

  return useApiResource<MarketBookResponse>(['order-book', marketId], load);
}

export function useActivity(query: ActivityQuery = {}) {
  const { marketId, account, limit, cursor } = query;
  const load = useCallback(
    () => apiClient.getActivity({ marketId, account, limit, cursor }),
    [account, cursor, limit, marketId],
  );
  return useApiResource<ActivityResponse>(
    ['activity', marketId, account, limit, cursor],
    load,
  );
}

export function useConfig() {
  const load = useCallback(() => apiClient.getConfig(), []);
  return useApiResource<RegistryConfig>(['config'], load);
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
