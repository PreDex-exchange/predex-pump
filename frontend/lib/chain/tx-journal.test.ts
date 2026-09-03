import { afterEach, describe, expect, it } from 'vitest';

import {
  ARC_TX_JOURNAL_STORAGE_KEY,
  readPendingArcTransactions,
  recordPendingArcTransaction,
  removePendingArcTransaction,
} from './tx-journal';

const NOW = 1_800_000_000_000;
const ACCOUNT = `0x${'12'.repeat(20)}` as const;

function hash(index: number) {
  return `0x${index.toString(16).padStart(64, '0')}` as const;
}

afterEach(() => localStorage.clear());

describe('Arc transaction journal', () => {
  it('records only the bounded recovery fields and removes terminal entries', () => {
    expect(
      recordPendingArcTransaction(
        {
          account: ACCOUNT,
          hash: hash(1),
          message: 'Buy YES is pending on Arc…',
        },
        localStorage,
        NOW,
      ),
    ).toBe(true);

    const stored = JSON.parse(
      localStorage.getItem(ARC_TX_JOURNAL_STORAGE_KEY) ?? 'null',
    ) as { entries: Array<Record<string, unknown>> };
    expect(Object.keys(stored.entries[0] ?? {}).sort()).toEqual([
      'account',
      'chainId',
      'hash',
      'message',
      'submittedAt',
    ]);
    expect(readPendingArcTransactions(localStorage, NOW)).toHaveLength(1);

    removePendingArcTransaction(hash(1), localStorage, NOW);
    expect(readPendingArcTransactions(localStorage, NOW)).toEqual([]);
    expect(localStorage.getItem(ARC_TX_JOURNAL_STORAGE_KEY)).toBeNull();
  });

  it('drops malformed, expired, foreign-chain, and oversized stored data', () => {
    localStorage.setItem(ARC_TX_JOURNAL_STORAGE_KEY, '{not-json');
    expect(readPendingArcTransactions(localStorage, NOW)).toEqual([]);
    expect(localStorage.getItem(ARC_TX_JOURNAL_STORAGE_KEY)).toBeNull();

    localStorage.setItem(
      ARC_TX_JOURNAL_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: [
          {
            account: ACCOUNT,
            chainId: 1,
            hash: hash(1),
            message: 'Wrong chain',
            submittedAt: NOW,
          },
          {
            account: ACCOUNT,
            chainId: 5_042_002,
            hash: 'not-a-hash',
            message: 'Malformed hash',
            submittedAt: NOW,
          },
          {
            account: ACCOUNT,
            chainId: 5_042_002,
            hash: hash(2),
            message: 'Expired',
            submittedAt: NOW - 8 * 24 * 60 * 60 * 1_000,
          },
          {
            account: ACCOUNT,
            chainId: 5_042_002,
            hash: hash(3),
            message: 'x'.repeat(241),
            submittedAt: NOW,
          },
        ],
      }),
    );
    expect(readPendingArcTransactions(localStorage, NOW)).toEqual([]);
    expect(localStorage.getItem(ARC_TX_JOURNAL_STORAGE_KEY)).toBeNull();
  });

  it('deduplicates hashes and keeps only the eight newest valid entries', () => {
    for (let index = 0; index < 10; index += 1) {
      recordPendingArcTransaction(
        {
          account: ACCOUNT,
          hash: hash(index),
          message: `Transaction ${index}`,
        },
        localStorage,
        NOW + index,
      );
    }
    recordPendingArcTransaction(
      { account: ACCOUNT, hash: hash(9), message: 'Newest duplicate' },
      localStorage,
      NOW + 20,
    );

    const entries = readPendingArcTransactions(localStorage, NOW + 20);
    expect(entries).toHaveLength(8);
    expect(entries[0]).toMatchObject({ hash: hash(9), message: 'Newest duplicate' });
    expect(entries.map((entry) => entry.hash)).not.toContain(hash(0));
    expect(entries.map((entry) => entry.hash)).not.toContain(hash(1));
  });
});
