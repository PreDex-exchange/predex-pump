'use client';

import type { Market } from '@predex-pump/shared/domain';
import type { MarketDetailResponse } from '@predex-pump/shared/rest';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { backendWsClient } from './websocket';

function marketFromData(data: unknown): Market | null {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('id' in data) ||
    typeof data.id !== 'string'
  ) {
    return null;
  }
  return data as Market;
}

/**
 * Keep global channels alive across route changes. This prevents a create or
 * graduation event from being missed while its feed/detail query is unmounted.
 */
export function BackendLiveSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsubscribeMarkets = backendWsClient.subscribe(
      'markets',
      (message) => {
        void queryClient.invalidateQueries({ queryKey: ['markets'] });

        const market = marketFromData(message.data);
        if (!market) return;
        const detailKey = ['market', market.id] as const;
        const hasDetailQuery =
          queryClient.getQueryState(detailKey) !== undefined;

        if (message.event === 'market.created') {
          void queryClient.invalidateQueries({
            queryKey: ['order-book', market.id],
          });
          void queryClient.invalidateQueries({
            queryKey: ['price-history', market.id],
          });
        }

        if (message.event === 'market.created' || hasDetailQuery) {
          queryClient.setQueryData<MarketDetailResponse | null>(
            detailKey,
            (current) => ({
              market,
              recentTrades: current?.recentTrades ?? [],
              resolution: current?.resolution ?? null,
            }),
          );
          void queryClient.invalidateQueries({
            exact: true,
            queryKey: detailKey,
          });
        }
      },
    );
    const unsubscribeActivity = backendWsClient.subscribe(
      'activity',
      () => {
        void queryClient.invalidateQueries({ queryKey: ['activity'] });
      },
    );

    return () => {
      unsubscribeMarkets();
      unsubscribeActivity();
    };
  }, [queryClient]);

  return null;
}
