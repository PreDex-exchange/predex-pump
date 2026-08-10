import 'dotenv/config';

import { loadRuntimeConfig } from './config.js';
import { prisma } from './db.js';
import {
  ViemOrderChainReader,
  createArcPublicClient,
} from './orderbook/chain-reader.js';
import { BookMigrationOperator } from './orderbook/migration.js';
import {
  createViemSettlementSubmitter,
  operatorAccountFromEnv,
  runOperatorLoop,
  SettlementOperator,
} from './orderbook/operator.js';
import { ViemSettlementPreflight } from './orderbook/preflight.js';

function pollMs(): number {
  const raw = process.env.OPERATOR_POLL_MS ?? '1000';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('OPERATOR_POLL_MS must be a positive integer');
  }
  return value;
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const account = operatorAccountFromEnv();
  const client = createArcPublicClient(config.rpcUrls);
  const submitter = createViemSettlementSubmitter(account, config.rpcUrl);
  const settlementOperator = new SettlementOperator(
    prisma,
    new ViemSettlementPreflight(client),
    submitter,
  );
  const logger = {
    info: (message: string): void => console.info(message),
    warn: (message: string): void => console.warn(message),
  };
  const migrationOperator = new BookMigrationOperator(
    prisma,
    new ViemOrderChainReader(client),
    submitter,
    account,
    logger,
  );
  // P4 runs inside the existing P2 operator loop. Migration gets first chance
  // so a post-cancel restart restores the book before new settlements proceed.
  const operator = {
    processOnce: async () => {
      const migration = await migrationOperator.processOnce();
      return migration.outcome === 'IDLE'
        ? settlementOperator.processOnce()
        : migration;
    },
  };
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.info(`[operator] started account=${account.address.toLowerCase()}`);
  try {
    await runOperatorLoop(operator, {
      signal: controller.signal,
      pollMs: pollMs(),
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  // Do not print thrown RPC objects: they may embed calldata with signatures.
  console.error('[operator] fatal runtime failure');
  process.exitCode = 1;
});
