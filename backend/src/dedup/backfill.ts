import 'dotenv/config';

import { loadRuntimeConfig } from '../config.js';
import { prisma } from '../db.js';
import { parseMarketPhase } from './indexer.js';
import { PrismaMarketCatalog } from './market-catalog.js';
import { createDedupRuntime } from './runtime.js';

const PAGE_SIZE = 100;

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const runtime = createDedupRuntime(config, new PrismaMarketCatalog(prisma));
  let cursor: string | undefined;
  let indexed = 0;
  let failed = 0;

  console.info(`[dedup-backfill] provider=${runtime.provider.mode}`);
  while (true) {
    const markets = await prisma.market.findMany({
      select: { id: true, question: true, phase: true },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    if (markets.length === 0) break;

    for (const market of markets) {
      try {
        await runtime.indexer.indexMarket({
          marketId: market.id,
          question: market.question,
          phase: parseMarketPhase(market.phase),
        });
        indexed += 1;
      } catch (error) {
        failed += 1;
        console.warn(`[dedup-backfill] market=${market.id} failed`, error);
      }
    }
    cursor = markets.at(-1)?.id;
    console.info(`[dedup-backfill] indexed=${indexed} failed=${failed}`);
  }

  if (failed > 0) {
    throw new Error(`Dedup backfill completed with ${failed} failed markets`);
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
