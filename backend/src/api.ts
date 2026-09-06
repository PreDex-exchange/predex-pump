import 'dotenv/config';

import { buildServer } from './api/server.js';
import { closeApiRuntime, waitForAbort } from './api/runtime.js';
import { createNodeRedisPublicJsonReadCache } from './cache/node-redis.js';
import { loadRuntimeConfig } from './config.js';
import { prisma } from './db.js';
import { PrismaMarketCatalog } from './dedup/market-catalog.js';
import { createDedupRuntime } from './dedup/runtime.js';
import { ServerEventBus } from './events/bus.js';
import { createNodeRedisPublicEventPlane } from './events/node-redis.js';
import {
  predexPublicEventDeployment,
  type PublicEventPlane,
} from './events/public-plane.js';
import { publishIndexedEvents } from './events/projector.js';
import { terminateOnFatal } from './fatal.js';
import {
  createTruthPaymentGate,
  loadTruthSellerConfig,
} from './truth-payment/config.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const dedup = createDedupRuntime(config, new PrismaMarketCatalog(prisma));
  const truthSeller = loadTruthSellerConfig();
  const truthPaymentGate = createTruthPaymentGate(truthSeller);
  const eventBus = new ServerEventBus();
  const publicReadCache = createNodeRedisPublicJsonReadCache({
    url: config.redisUrl,
    keyPrefix: config.redisKeyPrefix,
  });
  let publicEventPlane: PublicEventPlane | undefined;
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    publicEventPlane = createNodeRedisPublicEventPlane({
      url: config.redisUrl,
      deployment: predexPublicEventDeployment(config.redisKeyPrefix),
      handlers: {
        onIndexedBatch: (events) => publishIndexedEvents(prisma, eventBus, events),
        onServerEvent: (event, ts) => eventBus.publish(event, ts),
      },
    });
    app = await buildServer({
      prisma,
      eventBus,
      dedupChecker: dedup.checker,
      dedupIndexHealthReader: dedup.indexHealth,
      indexerStallMs: config.indexerStallMs,
      publicReadCache,
      publicEventPlane,
      marketListCacheTtlSeconds: config.marketsCacheTtlSeconds,
      ...(truthPaymentGate === undefined ? {} : { truthPaymentGate }),
    });
    await app.listen({ host: config.apiHost, port: config.apiPort });
    console.info(
      `[api] REST=http://${config.apiHost}:${config.apiPort} ` +
        `WebSocket=ws://${config.apiHost}:${config.apiPort}/ws`,
    );
    console.info(`[dedup] provider=${dedup.provider.mode} qdrant=${config.qdrantUrl}`);
    console.info(`[truth] seller=${truthSeller.mode} priceRaw=${truthSeller.amountRaw}`);
    await waitForAbort(controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (app !== undefined && publicEventPlane !== undefined) {
      await closeApiRuntime({ app, publicEventPlane, publicReadCache, prisma });
    } else {
      await publicEventPlane?.close();
      await publicReadCache.close();
      await prisma.$disconnect();
    }
  }
}

void main().catch(terminateOnFatal);
