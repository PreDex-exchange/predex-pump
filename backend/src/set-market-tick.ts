import 'dotenv/config';

import { prisma } from './db.js';
import {
  MarketTickUpdateError,
  setMarketMinimumTickSize,
} from './orderbook/tick.js';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Usage: pnpm operator:set-tick -- --market-id ID --tick-size-raw TICK`);
  }
  return value;
}

async function main(): Promise<void> {
  const marketId = option('--market-id');
  if (!/^(0|[1-9][0-9]*)$/u.test(marketId)) {
    throw new Error('--market-id must be an unsigned decimal integer');
  }
  const market = await setMarketMinimumTickSize(
    prisma,
    marketId,
    option('--tick-size-raw'),
  );
  console.info(
    `[operator] market=${market.id} minimumTickSizeRaw=${market.minimumTickSizeRaw}`,
  );
}

void main()
  .catch((error: unknown) => {
    console.error(
      error instanceof MarketTickUpdateError || error instanceof Error
        ? error.message
        : 'Market tick update failed',
    );
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
