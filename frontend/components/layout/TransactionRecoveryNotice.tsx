'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hash } from 'viem';

import { arcPublicClient } from '@/lib/chain/client';
import {
  readPendingArcTransactions,
  removePendingArcTransaction,
  type PendingArcTransaction,
} from '@/lib/chain/tx-journal';
import { shortAddress } from '@/lib/format';

import styles from './TransactionRecoveryNotice.module.css';

const ARCSCAN_URL = 'https://testnet.arcscan.app';
const RECEIPT_TIMEOUT_MS = 15_000;

type RecoveryPhase = 'checking' | 'confirmed' | 'reverted' | 'unknown';

interface RecoveryItem extends PendingArcTransaction {
  phase: RecoveryPhase;
}

function recoveryMessage(phase: RecoveryPhase) {
  if (phase === 'confirmed') return 'Recovered: this Arc transaction confirmed.';
  if (phase === 'reverted') {
    return 'Recovered: this Arc transaction reverted. Its state changes were not applied.';
  }
  if (phase === 'unknown') {
    return 'Arc could not confirm this saved transaction yet. Check its hash before retrying.';
  }
  return 'Checking a transaction submitted before this page loaded…';
}

export function TransactionRecoveryNotice() {
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const checkEntry = useCallback(async (entry: PendingArcTransaction) => {
    const key = entry.hash.toLowerCase();
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setItems((current) =>
      current.map((item) =>
        item.hash.toLowerCase() === key ? { ...item, phase: 'checking' } : item,
      ),
    );
    try {
      const receipt = await arcPublicClient.waitForTransactionReceipt({
        confirmations: 1,
        hash: entry.hash,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      const phase = receipt.status === 'success' ? 'confirmed' : 'reverted';
      removePendingArcTransaction(entry.hash);
      if (mounted.current) {
        setItems((current) =>
          current.map((item) =>
            item.hash.toLowerCase() === key ? { ...item, phase } : item,
          ),
        );
      }
    } catch {
      if (mounted.current) {
        setItems((current) =>
          current.map((item) =>
            item.hash.toLowerCase() === key
              ? { ...item, phase: 'unknown' }
              : item,
          ),
        );
      }
    } finally {
      inFlight.current.delete(key);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const entries = readPendingArcTransactions();
      setItems(entries.map((entry) => ({ ...entry, phase: 'checking' })));
      for (const entry of entries) void checkEntry(entry);
    });
    return () => {
      cancelled = true;
    };
  }, [checkEntry]);

  const dismiss = useCallback((hash: Hash) => {
    setItems((current) =>
      current.filter((item) => item.hash.toLowerCase() !== hash.toLowerCase()),
    );
  }, []);

  if (items.length === 0) return null;

  return (
    <aside aria-label="Recovered Arc transactions" className={styles.stack}>
      {items.map((item) => {
        const terminal = item.phase === 'confirmed' || item.phase === 'reverted';
        return (
          <div
            className={`${styles.notice} ${styles[item.phase]}`}
            key={item.hash}
            role={item.phase === 'reverted' ? 'alert' : 'status'}
          >
            <span aria-hidden="true" className={styles.dot} />
            <div className={styles.copy}>
              <strong>{recoveryMessage(item.phase)}</strong>
              <span>{item.message}</span>
            </div>
            <div className={styles.actions}>
              <a
                aria-label={`View transaction ${item.hash} on Arcscan`}
                href={`${ARCSCAN_URL}/tx/${item.hash}`}
                rel="noreferrer"
                target="_blank"
              >
                {shortAddress(item.hash, 8, 6)}
              </a>
              {item.phase === 'unknown' ? (
                <button onClick={() => void checkEntry(item)} type="button">
                  Check again
                </button>
              ) : terminal ? (
                <button onClick={() => dismiss(item.hash)} type="button">
                  Dismiss
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
