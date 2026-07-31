import 'dotenv/config';

import { buildServer } from './api/server.js';
import { loadRuntimeConfig } from './config.js';
import { prisma } from './db.js';
import { createDedupRuntime } from './dedup/runtime.js';
import { ServerEventBus } from './events/bus.js';
import { publishIndexedEvents } from './events/projector.js';
import { terminateOnFatal } from './fatal.js';
import { runIndexer } from './indexer/runner.js';
import {
  createTruthPaymentGate,
  loadTruthSellerConfig,
} from './truth-payment/config.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const dedup = createDedupRuntime(config);
  const truthSeller = loadTruthSellerConfig();
  const truthPaymentGate = createTruthPaymentGate(truthSeller);
  const eventBus = new ServerEventBus();
  const app = await buildServer({
    prisma,
    eventBus,
    dedupChecker: dedup.checker,
    indexerStallMs: config.indexerStallMs,
    ...(truthPaymentGate === undefined ? {} : { truthPaymentGate }),
  });

  try {
    await app.listen({ host: config.apiHost, port: config.apiPort });
    console.info(
      `[server] REST=http://${config.apiHost}:${config.apiPort} ` +
        `WebSocket=ws://${config.apiHost}:${config.apiPort}/ws`,
    );
    console.info(`[dedup] provider=${dedup.provider.mode} qdrant=${config.qdrantUrl}`);
    console.info(
      `[truth] seller=${truthSeller.mode} priceRaw=${truthSeller.amountRaw}`,
    );
    await runIndexer(prisma, config, {
      once: false,
      onEvents: (events) => publishIndexedEvents(prisma, eventBus, events),
      marketDedupIndexer: dedup.indexer,
    });
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

void main().catch(terminateOnFatal);
