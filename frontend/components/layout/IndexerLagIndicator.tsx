'use client';

import type { HealthResponse } from '@predex-pump/shared/rest';

import { useHealth } from '@/lib/api/hooks';

import styles from './IndexerLagIndicator.module.css';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isProviderHealth(value: unknown) {
  return (
    isRecord(value) &&
    isNullableNumber(value.indexedMarketCount) &&
    isNullableNumber(value.missingMarketCount)
  );
}

function isHealthResponse(value: unknown): value is HealthResponse {
  if (!isRecord(value) || !isRecord(value.chainState) || !isRecord(value.dedupIndex)) {
    return false;
  }
  const { chainState, dedupIndex } = value;
  const providers = dedupIndex.providers;
  const historyGaps = value.historyGaps;
  const configuredProvider = dedupIndex.configuredProvider;
  return (
    typeof value.ok === 'boolean' &&
    typeof value.indexerStatus === 'string' &&
    typeof value.lagBlocks === 'number' &&
    typeof value.indexedBlock === 'number' &&
    typeof value.headBlock === 'number' &&
    isNullableNumber(value.secondsSinceLastSuccessfulPoll) &&
    typeof value.balancesReconciled === 'boolean' &&
    typeof chainState.ready === 'boolean' &&
    typeof chainState.status === 'string' &&
    isNullableNumber(chainState.attemptedBlock) &&
    Array.isArray(chainState.issues) &&
    chainState.issues.every((issue) => typeof issue === 'string') &&
    isNullableString(chainState.error) &&
    typeof dedupIndex.status === 'string' &&
    (configuredProvider === 'openai' || configuredProvider === 'fallback') &&
    (dedupIndex.queryProvider === null ||
      dedupIndex.queryProvider === 'openai' ||
      dedupIndex.queryProvider === 'fallback') &&
    isRecord(providers) &&
    isProviderHealth(providers.openai) &&
    isProviderHealth(providers.fallback) &&
    isNullableString(dedupIndex.error) &&
    Array.isArray(historyGaps) &&
    historyGaps.every(
      (gap) =>
        isRecord(gap) &&
        typeof gap.skippedFromBlock === 'number' &&
        typeof gap.skippedToBlock === 'number' &&
        typeof gap.skippedBlockCount === 'number' &&
        typeof gap.recordedAt === 'string' &&
        typeof gap.balanceReconciliationStatus === 'string' &&
        isNullableString(gap.balanceReconciliationError),
    )
  );
}

function UnknownHealthIndicator() {
  return (
    <span
      aria-live="polite"
      className={styles.indicator}
      role="status"
      title="The backend health response is unavailable or uses an unsupported contract."
    >
      <span aria-hidden="true" className={styles.dot} />
      Health unknown
    </span>
  );
}

export function IndexerLagIndicator() {
  const { data } = useHealth();
  if (!data) return <UnknownHealthIndicator />;
  if (!isHealthResponse(data)) return <UnknownHealthIndicator />;
  if (
    data.indexerStatus === 'healthy' &&
      data.ok &&
      data.lagBlocks <= 0 &&
      data.balancesReconciled &&
      data.chainState.ready &&
      data.dedupIndex.status === 'ready' &&
      data.historyGaps.length === 0
  ) {
    return null;
  }

  const lagBlocks = Math.max(0, data.lagBlocks);
  const latestGap = data.historyGaps[0];
  const unreconciledGap = data.historyGaps.find(
    (gap) => gap.balanceReconciliationStatus !== 'complete',
  );
  let label = 'Indexer catching up';
  if (data.indexerStatus === 'stalled') {
    label = 'Indexer stalled';
  } else if (!data.chainState.ready) {
    label =
      data.chainState.status === 'failed' || data.chainState.issues.length > 0
        ? 'Chain configuration unavailable'
        : 'Chain configuration bootstrap pending';
  } else if (unreconciledGap !== undefined) {
    label = 'Balances unreconciled after indexer gap';
  } else if (latestGap !== undefined) {
    label = `Indexer history gap (${latestGap.skippedBlockCount.toLocaleString('en-US')} blocks)`;
  } else if (data.dedupIndex.status === 'unavailable') {
    label = 'Duplicate check unavailable';
  } else if (data.dedupIndex.status === 'degraded') {
    label =
      data.dedupIndex.queryProvider === 'fallback'
        ? 'Duplicate index using fallback'
        : 'Duplicate index degraded';
  } else if (data.indexerStatus === 'degraded') {
    label = 'Indexer retrying';
  } else if (lagBlocks > 0) {
    label = `Indexer ${lagBlocks} ${lagBlocks === 1 ? 'block' : 'blocks'} behind`;
  }
  const lastPoll =
    data.secondsSinceLastSuccessfulPoll === null
      ? 'No successful indexer poll recorded'
      : `Last successful poll ${data.secondsSinceLastSuccessfulPoll.toLocaleString('en-US')} seconds ago`;
  const historyGap =
    latestGap === undefined
      ? ''
      : `. History skipped blocks ${latestGap.skippedFromBlock.toLocaleString('en-US')}-${latestGap.skippedToBlock.toLocaleString('en-US')} at ${latestGap.recordedAt}`;
  const balanceReconciliation =
    unreconciledGap === undefined
      ? ''
      : `. Balance reconciliation ${unreconciledGap.balanceReconciliationStatus}` +
        (unreconciledGap.balanceReconciliationError === null
          ? ''
          : `: ${unreconciledGap.balanceReconciliationError}`);
  const chainState = data.chainState.ready
    ? ''
    : `. Chain configuration bootstrap ${data.chainState.status}` +
      (data.chainState.attemptedBlock === null
        ? ''
        : ` at block ${data.chainState.attemptedBlock.toLocaleString('en-US')}`) +
      (data.chainState.issues.length === 0
        ? ''
        : `; invalid snapshots: ${data.chainState.issues.join(', ')}`) +
      (data.chainState.error === null ? '' : `; error: ${data.chainState.error}`);
  const dedupProvider = data.dedupIndex.providers[data.dedupIndex.configuredProvider];
  const dedupIndex =
    data.dedupIndex.status === 'ready'
      ? ''
      : `. Duplicate index ${data.dedupIndex.status}; configured provider ${data.dedupIndex.configuredProvider}; ` +
        `query provider ${data.dedupIndex.queryProvider ?? 'none'}; ` +
        `indexed ${dedupProvider.indexedMarketCount ?? 'unknown'}, ` +
        `missing ${dedupProvider.missingMarketCount ?? 'unknown'}` +
        (data.dedupIndex.error === null ? '' : `; error: ${data.dedupIndex.error}`);

  return (
    <span
      aria-live="polite"
      className={styles.indicator}
      role="status"
      title={`${lastPoll}. Indexed block ${data.indexedBlock.toLocaleString('en-US')} of ${data.headBlock.toLocaleString('en-US')}${historyGap}${balanceReconciliation}${chainState}${dedupIndex}`}
    >
      <span aria-hidden="true" className={styles.dot} />
      {label}
    </span>
  );
}
