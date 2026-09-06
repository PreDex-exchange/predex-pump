import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';

import type { PublicJsonReadCache } from '../cache/public-json.js';
import type { PublicEventPlane } from '../events/public-plane.js';

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Close every standalone API resource even when an earlier close reports failure. */
export async function closeApiRuntime(resources: {
  app: Pick<FastifyInstance, 'close'>;
  publicEventPlane: Pick<PublicEventPlane, 'close'>;
  publicReadCache: Pick<PublicJsonReadCache, 'close'>;
  prisma: Pick<PrismaClient, '$disconnect'>;
}): Promise<void> {
  let firstFailure: unknown;
  for (const close of [
    () => resources.app.close(),
    () => resources.publicEventPlane.close(),
    () => resources.publicReadCache.close(),
    () => resources.prisma.$disconnect(),
  ]) {
    try {
      await close();
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}
