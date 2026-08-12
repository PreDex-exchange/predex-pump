import 'dotenv/config';

import { loadRuntimeConfig } from './config.js';
import { prisma } from './db.js';
import { PrismaMarketCatalog } from './dedup/market-catalog.js';
import { createDedupRuntime } from './dedup/runtime.js';
import { INDEXER_HELP, parseIndexerOptions } from './indexer/cli.js';
import { runIndexer } from './indexer/runner.js';

async function main(): Promise<void> {
  const parsed = parseIndexerOptions(process.argv.slice(2));
  if (parsed.help) {
    console.info(INDEXER_HELP);
    return;
  }
  const config = loadRuntimeConfig();
  const dedup = createDedupRuntime(config, new PrismaMarketCatalog(prisma));
  console.info(`[dedup] provider=${dedup.provider.mode} qdrant=${config.qdrantUrl}`);
  await runIndexer(prisma, config, {
    ...parsed.options,
    marketDedupIndexer: dedup.indexer,
  });
}

main()
  .catch((error: unknown) => {
    console.error('[indexer] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
