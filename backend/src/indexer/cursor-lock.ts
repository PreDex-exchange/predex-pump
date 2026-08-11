import type { Prisma } from '@prisma/client';

export interface LockedIndexerCursor {
  lastBlock: number;
  headBlock: number;
}

/**
 * Serialize absolute balance snapshots with event-delta application.
 *
 * Both callers hold this row lock for their full database transaction. That
 * makes the IndexerState cursor the boundary between an absolute chain
 * snapshot and the next transfer delta, instead of allowing either side to
 * overwrite the other.
 */
export async function lockIndexerCursor(
  tx: Prisma.TransactionClient,
): Promise<LockedIndexerCursor> {
  const rows = await tx.$queryRaw<LockedIndexerCursor[]>`
    SELECT "lastBlock", "headBlock"
    FROM "IndexerState"
    WHERE "id" = 1
    FOR UPDATE
  `;
  const cursor = rows[0];
  if (cursor === undefined) {
    throw new Error('IndexerState id=1 is required for balance reconciliation');
  }
  return cursor;
}
