'use client';

import { useEffect, useState } from 'react';

const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;

export function useEffectiveTradingOpen(
  indexedTradingOpen: boolean,
  tradingEndsAt: number,
): boolean {
  const deadlineMs = tradingEndsAt * 1_000;
  const [deadlineReached, setDeadlineReached] = useState(
    () => Date.now() >= deadlineMs,
  );

  useEffect(() => {
    if (deadlineReached) return;

    let timeout: number | undefined;
    const closeAtDeadline = () => {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        setDeadlineReached(true);
        return;
      }
      timeout = window.setTimeout(
        closeAtDeadline,
        Math.min(remainingMs, MAX_BROWSER_TIMEOUT_MS),
      );
    };

    closeAtDeadline();
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [deadlineMs, deadlineReached]);

  return indexedTradingOpen && !deadlineReached;
}
