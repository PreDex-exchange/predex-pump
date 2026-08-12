import 'dotenv/config';

import { buildServer } from './api/server.js';
import { loadRuntimeConfig } from './config.js';
import { prisma } from './db.js';
import { PrismaMarketCatalog } from './dedup/market-catalog.js';
import { createDedupRuntime } from './dedup/runtime.js';
import { ServerEventBus } from './events/bus.js';
import { publishIndexedEvents } from './events/projector.js';
import { terminateOnFatal } from './fatal.js';
import { parseServerOptions, SERVER_HELP } from './indexer/cli.js';
import { runIndexer } from './indexer/runner.js';
import {
  createTruthPaymentGate,
  loadTruthSellerConfig,
} from './truth-payment/config.js';

async function main(): Promise<void> {
  const parsed = parseServerOptions(process.argv.slice(2));
  if (parsed.help) {
    console.info(SERVER_HELP);
    return;
  }
  const config = loadRuntimeConfig();
  const dedup = createDedupRuntime(config, new PrismaMarketCatalog(prisma));
  const truthSeller = loadTruthSellerConfig();
  const truthPaymentGate = createTruthPaymentGate(truthSeller);
  const eventBus = new ServerEventBus();
  const app = await buildServer({
    prisma,
    eventBus,
    dedupChecker: dedup.checker,
    dedupIndexHealthReader: dedup.indexHealth,
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
      ...(parsed.startPolicy === undefined
        ? {}
        : { startPolicy: parsed.startPolicy }),
      onEvents: (events) => publishIndexedEvents(prisma, eventBus, events),
      marketDedupIndexer: dedup.indexer,
    });
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

void main().catch(terminateOnFatal);
