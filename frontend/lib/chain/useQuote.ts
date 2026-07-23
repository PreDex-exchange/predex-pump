'use client';

import { useMemo } from 'react';
import { maxUint256 } from 'viem';
import { useReadContract } from 'wagmi';

import { arcAddresses, arcTestnet } from './arc';
import { incubatorLmsrAbi } from './contracts';

export interface QuoteRequest {
  marketId: string;
  outcome: 'YES' | 'NO';
  mode: 'buy' | 'sell';
  amountRaw: string;
  priceRaw?: string;
  slippageBps?: number;
  live?: boolean;
}

export interface QuoteView {
  avgPriceRaw: string;
  sharesRaw: string;
  feeRaw: string;
  totalRaw: string;
  maxOrMinRaw: string;
}

interface BuyQuote {
  baseCostRaw: bigint;
  protocolFeeRaw: bigint;
  depthContributionRaw: bigint;
  totalCostRaw: bigint;
}

interface SellQuote {
  grossBaseProceedsRaw: bigint;
  protocolFeeRaw: bigint;
  depthContributionRaw: bigint;
  netProceedsRaw: bigint;
}

function safeBigInt(value: string) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function addSlippage(raw: bigint, bps: bigint) {
  return (raw * (10_000n + bps) + 9_999n) / 10_000n;
}

function subtractSlippage(raw: bigint, bps: bigint) {
  return (raw * (10_000n - bps)) / 10_000n;
}

export function useQuote({
  marketId,
  outcome,
  mode,
  amountRaw,
  slippageBps = 50,
}: QuoteRequest) {
  const amount = safeBigInt(amountRaw);
  const read = useReadContract({
    address: arcAddresses.lmsr,
    abi: incubatorLmsrAbi,
    functionName: mode === 'buy' ? 'quoteBuy' : 'quoteSell',
    args: [
      safeBigInt(marketId),
      outcome === 'YES' ? 0 : 1,
      amount,
      mode === 'buy' ? maxUint256 : 0n,
      maxUint256,
    ],
    chainId: arcTestnet.id,
    query: {
      enabled: amount > 0n,
      refetchInterval: 8_000,
      staleTime: 4_000,
    },
  });

  const quote = useMemo<QuoteView | null>(() => {
    if (!read.data || amount === 0n) return null;
    const slippage = BigInt(slippageBps);
    if (mode === 'buy') {
      const value = read.data as BuyQuote;
      return {
        avgPriceRaw: ((value.baseCostRaw * 1_000_000n) / amount).toString(),
        sharesRaw: amount.toString(),
        feeRaw: (
          value.protocolFeeRaw + value.depthContributionRaw
        ).toString(),
        totalRaw: value.totalCostRaw.toString(),
        maxOrMinRaw: addSlippage(value.totalCostRaw, slippage).toString(),
      };
    }
    const value = read.data as SellQuote;
    return {
      avgPriceRaw: (
        (value.grossBaseProceedsRaw * 1_000_000n) /
        amount
      ).toString(),
      sharesRaw: amount.toString(),
      feeRaw: (
        value.protocolFeeRaw + value.depthContributionRaw
      ).toString(),
      totalRaw: value.netProceedsRaw.toString(),
      maxOrMinRaw: subtractSlippage(
        value.netProceedsRaw,
        slippage,
      ).toString(),
    };
  }, [amount, mode, read.data, slippageBps]);

  return {
    quote,
    source: 'chain' as const,
    chainQuote: read.data,
    isLoading: read.isLoading && !read.data,
    isRefreshing: read.isFetching && Boolean(read.data),
    error: read.error,
    refetch: read.refetch,
  };
}
