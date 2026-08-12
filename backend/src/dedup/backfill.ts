import 'dotenv/config';

import { loadRuntimeConfig } from '../config.js';
import { prisma } from '../db.js';
import {
  dedupBackfillHasFailures,
  formatDedupBackfillSummary,
  runDedupBackfill,
} from './backfill-runner.js';
import { parseMarketPhase } from './indexer.js';
import { PrismaMarketCatalog } from './market-catalog.js';
import { createDedupRuntime } from './runtime.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const runtime = createDedupRuntime(config, new PrismaMarketCatalog(prisma));

  console.info(`[dedup-backfill] provider=${runtime.provider.mode}`);
  const summary = await runDedupBackfill({
    configuredProvider: runtime.provider.mode,
    indexer: runtime.indexer,
    readPage: async (cursor, pageSize) => {
      const markets = await prisma.market.findMany({
        select: { id: true, question: true, phase: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
      return markets.map((market) => ({
        marketId: market.id,
        question: market.question,
        phase: parseMarketPhase(market.phase),
      }));
    },
  });

  if (dedupBackfillHasFailures(summary)) {
    throw new Error(
      `Dedup backfill did not populate every requested provider partition: ${formatDedupBackfillSummary(summary)}`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error('[dedup-backfill] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
