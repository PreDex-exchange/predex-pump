'use client';

import incubatorLmsrAbiJson from '@predex-pump/shared/abis/IncubatorLMSR.json';
import { useMemo } from 'react';
import type { Abi } from 'viem';
import { useReadContract } from 'wagmi';

import { arcAddresses, arcTestnet } from './arc';

const incubatorLmsrAbi = incubatorLmsrAbiJson as Abi;

export interface QuoteRequest {
  marketId: string;
  outcome: 'YES' | 'NO';
  mode: 'buy' | 'sell';
  amountRaw: string;
  priceRaw?: string;
  slippageBps?: number;
  live?: boolean;
}

export interface MockQuote {
  avgPriceRaw: string;
  sharesRaw: string;
  feeRaw: string;
  totalRaw: string;
  maxOrMinRaw: string;
}

function safeBigInt(value: string) {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Tx-critical read pattern.
 *
 * Phase C1 returns a deterministic UI quote by default. Setting `live: true` enables
 * the ABI-backed `quoteBuy`/`quoteSell` read against Arc. A later write flow should
 * always re-read immediately before wallet confirmation and pass the resulting
 * max-cost/min-proceeds plus a fresh deadline to the contract.
 */
export function useQuote({
  marketId,
  outcome,
  mode,
  amountRaw,
  priceRaw,
  slippageBps = 50,
  live = false,
}: QuoteRequest) {
  const amount = safeBigInt(amountRaw);
  const mockPrice = safeBigInt(priceRaw ?? (outcome === 'YES' ? '520000' : '480000'));
  const gross = mode === 'buy' ? amount : (amount * mockPrice) / 1_000_000n;
  const fee = (gross * 20n) / 10_000n;
  const shares =
    mode === 'buy' ? (mockPrice === 0n ? 0n : (amount * 1_000_000n) / mockPrice) : amount;
  const total = mode === 'buy' ? amount : gross > fee ? gross - fee : 0n;
  const slippage = (total * BigInt(slippageBps)) / 10_000n;
  // Far-future read-only deadline for the Phase C1 pattern. A write flow must replace
  // this with a fresh, short-lived deadline immediately before confirmation.
  const deadline = 4_102_444_800n;

  const mockQuote = useMemo<MockQuote>(
    () => ({
      avgPriceRaw: mockPrice.toString(),
      sharesRaw: shares.toString(),
      feeRaw: fee.toString(),
      totalRaw: total.toString(),
      maxOrMinRaw:
        mode === 'buy'
          ? (total + slippage).toString()
          : (total > slippage ? total - slippage : 0n).toString(),
    }),
    [fee, mockPrice, mode, shares, slippage, total],
  );

  const read = useReadContract({
    address: arcAddresses.lmsr,
    abi: incubatorLmsrAbi,
    functionName: mode === 'buy' ? 'quoteBuy' : 'quoteSell',
    args: [
      safeBigInt(marketId),
      outcome === 'YES' ? 0 : 1,
      amount,
      safeBigInt(mockQuote.maxOrMinRaw),
      deadline,
    ],
    chainId: arcTestnet.id,
    query: {
      enabled: live && amount > 0n,
    },
  });

  return {
    quote: mockQuote,
    source: live ? ('chain' as const) : ('mock' as const),
    chainQuote: read.data,
    isLoading: live && read.isLoading,
    error: read.error,
    refetch: read.refetch,
  };
}
