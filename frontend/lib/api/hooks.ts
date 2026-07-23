'use client';

import type {
  AccountResponse,
  ActivityQuery,
  ActivityResponse,
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
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { useCallback } from 'react';

import { apiClient } from './client';

interface ResourceState<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

function useApiResource<T>(queryKey: QueryKey, load: () => Promise<T>): ResourceState<T> {
  const query = useQuery<T, Error>({
    queryKey,
    queryFn: load,
    staleTime: 30_000,
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
  );
}

export function useMarket(id: string) {
  const load = useCallback(() => apiClient.getMarket(id), [id]);
  return useApiResource<MarketDetailResponse | null>(['market', id], load);
}

export function useAccount(address?: string) {
  const load = useCallback(
    () => (address ? apiClient.getAccount(address) : Promise.resolve(null)),
    [address],
  );
  return useApiResource<AccountResponse | null>(['account', address], load);
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
  const load = useCallback(() => apiClient.getOrderBook(marketId), [marketId]);
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
  const { fromTs, limit } = query;
  const load = useCallback(
    () => apiClient.getPriceHistory(marketId, { fromTs, limit }),
    [fromTs, limit, marketId],
  );
  return useApiResource<PriceHistoryResponse>(
    ['price-history', marketId, fromTs, limit],
    load,
  );
}
