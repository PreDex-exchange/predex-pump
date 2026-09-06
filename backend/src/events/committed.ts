import type { PublicJsonReadCache } from '../cache/public-json.js';
import type { DecodedEvent } from '../indexer/types.js';
import type { IndexedEventPublisher } from './public-plane.js';

/**
 * Called only from runIndexer's post-commit onEvents hook. Cache invalidation
 * precedes every notification so a notified reader cannot reuse the old epoch.
 */
export async function publishCommittedIndexedEvents(
  events: readonly DecodedEvent[],
  dependencies: {
    publicReadCache: Pick<PublicJsonReadCache, 'invalidate'>;
    publicEvents?: Pick<IndexedEventPublisher, 'publishIndexedBatch'>;
    publishLocal?: (events: readonly DecodedEvent[]) => Promise<void>;
  },
): Promise<void> {
  if (events.length === 0) return;
  // Redis cache failure cannot change an already committed indexer result.
  await dependencies.publicReadCache.invalidate('markets').catch(() => undefined);
  await dependencies.publishLocal?.(events);
  // The event plane is best effort and internally bounds/swallow Redis errors.
  if (dependencies.publicEvents !== undefined) {
    await dependencies.publicEvents.publishIndexedBatch(events).catch(() => undefined);
  }
}
