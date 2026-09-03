import type { Address, Hash } from 'viem';

import { ARC } from '@/lib/shared/addresses';

export const ARC_TX_JOURNAL_STORAGE_KEY = 'predex:arc-transactions:v1';

const JOURNAL_VERSION = 1;
const MAX_ENTRIES = 8;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_MESSAGE_LENGTH = 240;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/iu;
const HASH_PATTERN = /^0x[0-9a-f]{64}$/iu;

export interface PendingArcTransaction {
  account: Address;
  chainId: typeof ARC.chainId;
  hash: Hash;
  message: string;
  submittedAt: number;
}

interface StoredJournal {
  entries: PendingArcTransaction[];
  version: typeof JOURNAL_VERSION;
}

function browserStorage() {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function removeStoredJournal(storage: Storage) {
  try {
    storage.removeItem(ARC_TX_JOURNAL_STORAGE_KEY);
  } catch {
    // Recovery is best-effort and must never block an on-chain action.
  }
}

function writeEntries(storage: Storage, entries: PendingArcTransaction[]) {
  try {
    if (entries.length === 0) {
      storage.removeItem(ARC_TX_JOURNAL_STORAGE_KEY);
      return;
    }
    const journal: StoredJournal = { entries, version: JOURNAL_VERSION };
    storage.setItem(ARC_TX_JOURNAL_STORAGE_KEY, JSON.stringify(journal));
  } catch {
    // A disabled or full storage area must not change transaction behavior.
  }
}

function normalizedEntry(value: unknown, now: number): PendingArcTransaction | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.chainId !== ARC.chainId ||
    typeof candidate.hash !== 'string' ||
    !HASH_PATTERN.test(candidate.hash) ||
    typeof candidate.account !== 'string' ||
    !ADDRESS_PATTERN.test(candidate.account) ||
    typeof candidate.message !== 'string' ||
    candidate.message.length === 0 ||
    candidate.message.length > MAX_MESSAGE_LENGTH ||
    typeof candidate.submittedAt !== 'number' ||
    !Number.isSafeInteger(candidate.submittedAt) ||
    candidate.submittedAt < now - MAX_AGE_MS ||
    candidate.submittedAt > now + MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }
  return {
    account: candidate.account as Address,
    chainId: ARC.chainId,
    hash: candidate.hash as Hash,
    message: candidate.message,
    submittedAt: candidate.submittedAt,
  };
}

export function readPendingArcTransactions(
  storage: Storage | undefined = browserStorage(),
  now = Date.now(),
) {
  if (!storage) return [];
  let parsed: unknown;
  try {
    const raw = storage.getItem(ARC_TX_JOURNAL_STORAGE_KEY);
    if (raw === null) return [];
    parsed = JSON.parse(raw);
  } catch {
    removeStoredJournal(storage);
    return [];
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).version !== JOURNAL_VERSION ||
    !Array.isArray((parsed as Record<string, unknown>).entries)
  ) {
    removeStoredJournal(storage);
    return [];
  }

  const unique = new Map<string, PendingArcTransaction>();
  for (const rawEntry of (parsed as { entries: unknown[] }).entries) {
    const entry = normalizedEntry(rawEntry, now);
    if (!entry) continue;
    const key = entry.hash.toLowerCase();
    const current = unique.get(key);
    if (!current || current.submittedAt < entry.submittedAt) unique.set(key, entry);
  }
  const entries = [...unique.values()]
    .sort((left, right) => right.submittedAt - left.submittedAt)
    .slice(0, MAX_ENTRIES);
  writeEntries(storage, entries);
  return entries;
}

export function recordPendingArcTransaction(
  entry: Omit<PendingArcTransaction, 'chainId' | 'submittedAt'>,
  storage: Storage | undefined = browserStorage(),
  now = Date.now(),
) {
  if (!storage) return false;
  const normalized = normalizedEntry(
    { ...entry, chainId: ARC.chainId, submittedAt: now },
    now,
  );
  if (!normalized) return false;
  const entries = readPendingArcTransactions(storage, now).filter(
    ({ hash }) => hash.toLowerCase() !== normalized.hash.toLowerCase(),
  );
  writeEntries(storage, [normalized, ...entries].slice(0, MAX_ENTRIES));
  return true;
}

export function removePendingArcTransaction(
  hash: Hash,
  storage: Storage | undefined = browserStorage(),
  now = Date.now(),
) {
  if (!storage) return;
  const entries = readPendingArcTransactions(storage, now).filter(
    (entry) => entry.hash.toLowerCase() !== hash.toLowerCase(),
  );
  writeEntries(storage, entries);
}
