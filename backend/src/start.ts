import 'dotenv/config';

import { buildServer } from './api/server.js';
import { loadRuntimeConfig } from './config.js';
import { prisma } from './db.js';
import { ServerEventBus } from './events/bus.js';
import { publishIndexedEvents } from './events/projector.js';
import { runIndexer } from './indexer/runner.js';

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const eventBus = new ServerEventBus();
  const app = await buildServer({ prisma, eventBus });

  try {
    await app.listen({ host: config.apiHost, port: config.apiPort });
    console.info(
      `[server] REST=http://${config.apiHost}:${config.apiPort} ` +
        `WebSocket=ws://${config.apiHost}:${config.apiPort}/ws`,
    );
    await runIndexer(prisma, config, {
      once: false,
      onEvents: (events) => publishIndexedEvents(prisma, eventBus, events),
    });
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('[server] fatal', error);
  process.exitCode = 1;
});
