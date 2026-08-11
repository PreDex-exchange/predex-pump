import {
  createPublicClient,
  fallback,
  http,
  type Transport,
} from 'viem';

import { ARC } from '@/lib/shared/addresses';

import { arcTestnet } from './arc';

export const ARC_READ_CACHE_MS = 30_000;

/**
 * Concurrent readContract calls are collapsed into one Multicall3 eth_call.
 * React Query owns the longer-lived market/account cache; this client cache
 * also prevents duplicate low-level reads during a single render wave.
 */
export function createArcPublicClient(
  transport: Transport = fallback(
    ARC.rpcUrls.map((url) =>
      http(url, {
        retryCount: 1,
        timeout: 10_000,
      }),
    ),
    { retryCount: 0 },
  ),
) {
  return createPublicClient({
    batch: {
      multicall: {
        // Settlement is a small fixed read set; keep it in one aggregate3 call.
        batchSize: 100_000,
        wait: 16,
      },
    },
    cacheTime: ARC_READ_CACHE_MS,
    chain: arcTestnet,
    transport,
  });
}

export const arcPublicClient = createArcPublicClient();
