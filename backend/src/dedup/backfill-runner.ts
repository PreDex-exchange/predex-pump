import type {
  EmbeddingProviderMode,
  IndexableMarket,
  MarketDedupIndexer,
  MarketIndexResult,
} from './types.js';
import { MarketIndexingFailure } from './indexer.js';

export interface DedupBackfillSummary {
  processed: number;
  indexed: number;
  complete: number;
  degraded: number;
  partial: number;
  unindexed: number;
  indexedByProvider: Record<EmbeddingProviderMode, number>;
  providerFailures: Record<EmbeddingProviderMode, number>;
}

export interface DedupBackfillLogger {
  info(message: string): void;
  warn(message: string, error?: unknown): void;
}

export interface RunDedupBackfillOptions {
  configuredProvider: EmbeddingProviderMode;
  indexer: MarketDedupIndexer;
  readPage(
    cursor: string | undefined,
    pageSize: number,
  ): Promise<readonly IndexableMarket[]>;
  logger?: DedupBackfillLogger;
  pageSize?: number;
}

function emptySummary(): DedupBackfillSummary {
  return {
    processed: 0,
    indexed: 0,
    complete: 0,
    degraded: 0,
    partial: 0,
    unindexed: 0,
    indexedByProvider: { openai: 0, fallback: 0 },
    providerFailures: { openai: 0, fallback: 0 },
  };
}

function recordResult(
  summary: DedupBackfillSummary,
  result: MarketIndexResult,
): void {
  const indexedProviders = new Set(result.indexedProviders);
  const failedProviders = new Set(result.failedProviders);
  summary.processed += 1;
  if (indexedProviders.size === 0) {
    summary.unindexed += 1;
  } else {
    summary.indexed += 1;
  }
  if (failedProviders.size === 0) {
    summary.complete += 1;
  } else if (result.degradedToFallback) {
    summary.degraded += 1;
  } else if (indexedProviders.size > 0) {
    summary.partial += 1;
  }
  for (const provider of indexedProviders) {
    summary.indexedByProvider[provider] += 1;
  }
  for (const provider of failedProviders) {
    summary.providerFailures[provider] += 1;
  }
}

export function formatDedupBackfillSummary(
  summary: DedupBackfillSummary,
): string {
  return (
    `processed=${summary.processed} indexed=${summary.indexed} ` +
    `complete=${summary.complete} degraded=${summary.degraded} ` +
    `partial=${summary.partial} unindexed=${summary.unindexed} ` +
    `providers.openai=${summary.indexedByProvider.openai} ` +
    `providers.fallback=${summary.indexedByProvider.fallback} ` +
    `providerFailures.openai=${summary.providerFailures.openai} ` +
    `providerFailures.fallback=${summary.providerFailures.fallback}`
  );
}

export function dedupBackfillHasFailures(summary: DedupBackfillSummary): boolean {
  return (
    summary.unindexed > 0 ||
    summary.providerFailures.openai > 0 ||
    summary.providerFailures.fallback > 0
  );
}

export async function runDedupBackfill(
  options: RunDedupBackfillOptions,
): Promise<DedupBackfillSummary> {
  const pageSize = options.pageSize ?? 100;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error(`Dedup backfill page size must be positive, received ${pageSize}`);
  }
  const logger = options.logger ?? console;
  const summary = emptySummary();
  let cursor: string | undefined;

  while (true) {
    const markets = await options.readPage(cursor, pageSize);
    if (markets.length === 0) break;

    for (const market of markets) {
      try {
        const result = await options.indexer.indexMarket(market);
        recordResult(summary, result);
        if (result.failedProviders.length > 0) {
          logger.warn(
            `[dedup-backfill] market=${market.marketId} degraded ` +
              `indexed=${result.indexedProviders.join(',') || 'none'} ` +
              `providerFailures=${result.failedProviders.join(',')}`,
          );
        }
      } catch (error) {
        const result =
          error instanceof MarketIndexingFailure
            ? error.result
            : {
                configuredProvider: options.configuredProvider,
                indexedProviders: [],
                failedProviders: [options.configuredProvider],
                degradedToFallback: false,
              } satisfies MarketIndexResult;
        recordResult(summary, result);
        logger.warn(
          `[dedup-backfill] market=${market.marketId} incomplete ` +
            `indexed=${result.indexedProviders.join(',') || 'none'} ` +
            `providerFailures=${result.failedProviders.join(',') || 'none'}`,
          error,
        );
      }
    }
    cursor = markets.at(-1)?.marketId;
    logger.info(`[dedup-backfill] progress ${formatDedupBackfillSummary(summary)}`);
  }

  logger.info(`[dedup-backfill] complete ${formatDedupBackfillSummary(summary)}`);
  return summary;
}
