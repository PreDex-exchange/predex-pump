import type { PrismaClient } from '@prisma/client';

import type { PublicJsonReadCache } from '../cache/public-json.js';
import type { IndexedEventSubscriber } from '../events/public-plane.js';

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** Close every standalone API resource even when an earlier close reports failure. */
export async function closeApiRuntime(resources: {
  app: { close(): Promise<void> };
  publicEventPlane: Pick<IndexedEventSubscriber, 'close'>;
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
