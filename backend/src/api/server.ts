import cors from '@fastify/cors';
import type { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { unavailableDedupResponse } from '../dedup/service.js';
import type { DedupChecker } from '../dedup/types.js';
import type { ServerEventBus } from '../events/bus.js';
import type { TruthPaymentGate } from '../truth-payment/types.js';
import { registerRestRoutes } from './routes.js';
import { registerWebsocketRoute } from './websocket.js';

export interface BuildServerOptions {
  prisma: PrismaClient;
  eventBus: ServerEventBus;
  dedupChecker?: DedupChecker;
  indexerStallMs?: number;
  logger?: FastifyServerOptions['logger'];
  truthPaymentGate?: TruthPaymentGate;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
  });
  await app.register(cors, { origin: '*' });
  await registerWebsocketRoute(app, options.eventBus);
  registerRestRoutes(
    app,
    options.prisma,
    options.dedupChecker ?? { check: async () => unavailableDedupResponse() },
    options.indexerStallMs,
    options.truthPaymentGate,
  );
  await app.ready();
  return app;
}
