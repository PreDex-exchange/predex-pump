'use client';

import { useReadContract } from 'wagmi';

import { arcAddresses, arcTestnet } from './arc';
import { incubatorRegistryAbi } from './contracts';

export interface GraduationStatus {
  qualified: boolean;
  activityMoneyInRaw: string;
  activityThresholdRaw: string;
  openedAt: number;
  minimumTimeOpen: number;
  earliestGraduationAt: number;
}

export function useGraduationStatus(marketId: string) {
  const numericMarketId = /^\d+$/.test(marketId) ? BigInt(marketId) : 0n;
  const read = useReadContract({
    address: arcAddresses.registry,
    abi: incubatorRegistryAbi,
    functionName: 'graduationStatus',
    args: [numericMarketId],
    chainId: arcTestnet.id,
    query: {
      enabled: numericMarketId > 0n,
      refetchInterval: 8_000,
      staleTime: 4_000,
    },
  });
  const value = read.data as
    | readonly [boolean, bigint, bigint, bigint, bigint, bigint]
    | undefined;

  return {
    data: value
      ? {
          qualified: value[0],
          activityMoneyInRaw: value[1].toString(),
          activityThresholdRaw: value[2].toString(),
          openedAt: Number(value[3]),
          minimumTimeOpen: Number(value[4]),
          earliestGraduationAt: Number(value[5]),
        }
      : null,
    isLoading: read.isLoading && !value,
    isRefreshing: read.isFetching && Boolean(value),
    error: read.error,
    refetch: read.refetch,
  };
}
