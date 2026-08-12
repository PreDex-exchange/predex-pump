'use client';

import type { Market } from '@predex-pump/shared/domain';
import type { MarketDetailResponse } from '@predex-pump/shared/rest';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import styles from './live.module.css';
import {
  backendWsClient,
  type BackendConnectionStatus,
} from './websocket';

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
  const [connectionStatus, setConnectionStatus] =
    useState<BackendConnectionStatus>('connecting');
  const [isCatchingUp, setIsCatchingUp] = useState(false);
  const wasDisconnected = useRef(false);

  useEffect(() => {
    let active = true;
    let catchUpRun = 0;
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
              market: {
                ...market,
                resolution:
                  market.resolution ?? current?.resolution ?? null,
              },
              recentTrades: current?.recentTrades ?? [],
              resolution:
                market.resolution ?? current?.resolution ?? null,
              settlementEvents: current?.settlementEvents ?? {
                protocolSweepCompleted: false,
                protocolSweptRaw: '0',
              },
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
    const unsubscribeStatus = backendWsClient.subscribeStatus((status) => {
      if (!active) return;
      setConnectionStatus(status);
      if (status === 'reconnecting') {
        wasDisconnected.current = true;
        catchUpRun += 1;
        setIsCatchingUp(false);
        return;
      }
      if (status !== 'live' || !wasDisconnected.current) return;

      wasDisconnected.current = false;
      const currentRun = ++catchUpRun;
      setIsCatchingUp(true);
      const finishCatchUp = () => {
        if (active && catchUpRun === currentRun) setIsCatchingUp(false);
      };
      void queryClient.refetchQueries({ type: 'active' }).then(
        finishCatchUp,
        finishCatchUp,
      );
    });

    return () => {
      active = false;
      catchUpRun += 1;
      unsubscribeMarkets();
      unsubscribeActivity();
      unsubscribeStatus();
    };
  }, [queryClient]);

  if (connectionStatus !== 'reconnecting' && !isCatchingUp) return null;

  return (
    <p aria-live="assertive" className={styles.recovery} role="status">
      <span aria-hidden="true" className={styles.dot} />
      <span>
        <strong>
          {connectionStatus === 'reconnecting'
            ? 'Live data reconnecting'
            : 'Catching up live data'}
        </strong>
        <small>
          {connectionStatus === 'reconnecting'
            ? 'Prices and activity may be stale until the stream returns.'
            : 'Refreshing every active view from the indexed API.'}
        </small>
      </span>
    </p>
  );
}
