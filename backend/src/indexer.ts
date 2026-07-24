import 'dotenv/config';

import { loadRuntimeConfig } from './config.js';
import { prisma } from './db.js';
import { runIndexer, type IndexerOptions } from './indexer/runner.js';

function parseOptions(argv: readonly string[]): IndexerOptions {
  let once = false;
  let replayFrom: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--once') {
      once = true;
      continue;
    }
    if (argument?.startsWith('--replay-from=')) {
      replayFrom = Number(argument.slice('--replay-from='.length));
      continue;
    }
    if (argument === '--replay-from') {
      replayFrom = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown indexer option ${argument}`);
  }

  if (
    replayFrom !== undefined &&
    (!Number.isSafeInteger(replayFrom) || replayFrom < 0)
  ) {
    throw new Error(`Invalid --replay-from value ${String(replayFrom)}`);
  }
  return replayFrom === undefined ? { once } : { once, replayFrom };
}

async function main(): Promise<void> {
  await runIndexer(prisma, loadRuntimeConfig(), parseOptions(process.argv.slice(2)));
}

main()
  .catch((error: unknown) => {
    console.error('[indexer] fatal', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
