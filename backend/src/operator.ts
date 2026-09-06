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
  operatorAccountFromRuntime,
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

function tokenRegistrationEnabled(): boolean {
  const value = process.env.OPERATOR_REGISTER_TOKENS?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('OPERATOR_REGISTER_TOKENS must be true or false');
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const account = await operatorAccountFromRuntime();
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
  const registrationEnabled = tokenRegistrationEnabled();
  const migrationOperator = new BookMigrationOperator(
    prisma,
    new ViemOrderChainReader(client),
    submitter,
    account,
    logger,
    undefined,
    undefined,
    registrationEnabled,
  );
  // Migration gets first chance so a post-cutover restart restores the Hybrid
  // book before any newly activated settlement proceeds.
  const operator = {
    processOnce: async () => {
      const migration = await migrationOperator.processOnce();
      const registrationDeferred =
        migration.outcome === 'FAILED' &&
        (migration.failureCode === 'REGISTRATION_DISABLED' ||
          migration.failureCode === 'REGISTRATION_OUTCOME_UNKNOWN');
      return migration.outcome === 'IDLE' || registrationDeferred
        ? settlementOperator.processOnce()
        : migration;
    },
  };
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.info(
    `[operator] started account=${account.address.toLowerCase()} ` +
      `registerTokens=${registrationEnabled}`,
  );
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
