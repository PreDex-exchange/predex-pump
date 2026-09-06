import 'dotenv/config';

import { loadRuntimeConfig } from './config.js';
import { createNodeRedisPublicJsonReadCache } from './cache/node-redis.js';
import { prisma } from './db.js';
import { PrismaMarketCatalog } from './dedup/market-catalog.js';
import { createDedupRuntime } from './dedup/runtime.js';
import { publishCommittedIndexedEvents } from './events/committed.js';
import { createNodeRedisIndexedEventPublisher } from './events/node-redis.js';
import { predexPublicEventDeployment } from './events/public-plane.js';
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
  const publicReadCache = createNodeRedisPublicJsonReadCache({
    url: config.redisUrl,
    keyPrefix: config.redisKeyPrefix,
  });
  const publicEventPlane = createNodeRedisIndexedEventPublisher({
    url: config.redisUrl,
    deployment: predexPublicEventDeployment(config.redisKeyPrefix),
  });
  console.info(`[dedup] provider=${dedup.provider.mode} qdrant=${config.qdrantUrl}`);
  try {
    await runIndexer(prisma, config, {
      ...parsed.options,
      onEvents: (events) =>
        publishCommittedIndexedEvents(events, {
          publicReadCache,
          publicEvents: publicEventPlane,
        }),
      marketDedupIndexer: dedup.indexer,
    });
  } finally {
    await publicEventPlane.close();
    await publicReadCache.close();
  }
}

main()
  .catch((error: unknown) => {
    console.error('[indexer] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
