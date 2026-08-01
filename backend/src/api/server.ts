import cors from '@fastify/cors';
import type { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { loadAccountLayerConfig, type AccountLayerConfig } from '../account/config.js';
import { AccountService, type SiweVerifier } from '../account/service.js';
import { unavailableDedupResponse } from '../dedup/service.js';
import type { DedupChecker } from '../dedup/types.js';
import type { ServerEventBus } from '../events/bus.js';
import type { TruthPaymentGate } from '../truth-payment/types.js';
import { registerAccountRoutes } from './account-routes.js';
import { registerRestRoutes } from './routes.js';
import { registerWebsocketRoute } from './websocket.js';

export interface BuildServerOptions {
  prisma: PrismaClient;
  eventBus: ServerEventBus;
  dedupChecker?: DedupChecker;
  indexerStallMs?: number;
  logger?: FastifyServerOptions['logger'];
  truthPaymentGate?: TruthPaymentGate;
  accountLayerConfig?: AccountLayerConfig;
  siweVerifier?: SiweVerifier;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const accountLayerConfig = options.accountLayerConfig ?? loadAccountLayerConfig();
  const app = Fastify({
    logger: options.logger ?? true,
  });
  await app.register(cors, {
    origin: accountLayerConfig.webOrigin,
    credentials: true,
  });
  await registerWebsocketRoute(app, options.eventBus);
  registerRestRoutes(
    app,
    options.prisma,
    options.dedupChecker ?? { check: async () => unavailableDedupResponse() },
    options.indexerStallMs,
    options.truthPaymentGate,
  );
  registerAccountRoutes(
    app,
    new AccountService(options.prisma, accountLayerConfig, options.siweVerifier),
  );
  await app.ready();
  return app;
}
