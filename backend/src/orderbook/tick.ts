import type { Market, PrismaClient } from '@prisma/client';
import {
  ALLOWED_MINIMUM_TICK_SIZES_RAW,
  assertAllowedMinimumTickSizeRaw,
} from '@predex-pump/shared';

export class MarketTickUpdateError extends Error {
  constructor(
    readonly code: 'INVALID_TICK_SIZE' | 'MARKET_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'MarketTickUpdateError';
  }
}

function parseTickSize(value: string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new MarketTickUpdateError(
      'INVALID_TICK_SIZE',
      'minimumTickSizeRaw must be an unsigned decimal integer',
    );
  }
  return BigInt(value);
}

/**
 * Privileged operational mutation used by the backend-only CLI. Deliberately
 * updates only the market policy: signed/resting orders are not touched, so a
 * tick change applies solely to later order ingest.
 */
export async function setMarketMinimumTickSize(
  prisma: PrismaClient,
  marketId: string,
  minimumTickSizeRaw: string | bigint,
): Promise<Market> {
  const tick = parseTickSize(minimumTickSizeRaw);
  try {
    assertAllowedMinimumTickSizeRaw(tick);
  } catch {
    throw new MarketTickUpdateError(
      'INVALID_TICK_SIZE',
      `minimumTickSizeRaw must be one of ${ALLOWED_MINIMUM_TICK_SIZES_RAW.join(', ')}`,
    );
  }

  const updated = await prisma.market.updateMany({
    where: { id: marketId },
    data: { minimumTickSizeRaw: tick.toString() },
  });
  if (updated.count !== 1) {
    throw new MarketTickUpdateError(
      'MARKET_NOT_FOUND',
      `Market ${marketId} was not found`,
    );
  }
  return prisma.market.findUniqueOrThrow({ where: { id: marketId } });
}
