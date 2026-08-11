import 'dotenv/config';

import { prisma } from './db.js';
import {
  formatBalanceReconciliationChange,
  outstandingBalanceGapIds,
  reconcileIndexedBalances,
  ViemBalanceChainReader,
} from './reconciliation/balances.js';

const HELP = `Usage: pnpm operator:reconcile-balances

Reads CTF and USDC balances at the durable indexer cursor through Arc
Multicall3, repairs the bounded indexed balance scope, and marks outstanding
IndexerGap balance reconciliations complete only when every read is valid.`;

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.info(HELP);
    return;
  }
  const unknown = process.argv.slice(2).filter((argument) => argument !== '--');
  if (unknown.length > 0) {
    throw new Error(`Unknown option: ${unknown.join(' ')}`);
  }

  const gapIds = await outstandingBalanceGapIds(prisma);
  const result = await reconcileIndexedBalances(
    prisma,
    new ViemBalanceChainReader(),
    { gapIds },
  );
  for (const change of result.changes) {
    console.info(formatBalanceReconciliationChange(change));
  }
  for (const failure of result.failures) {
    console.error(
      `[reconcile-balances] account=${failure.account ?? 'unknown'} ` +
        `market=${failure.marketId ?? 'all'} asset=${failure.asset} ` +
        `error="${failure.error}"`,
    );
  }
  console.info(
    `[reconcile-balances] block=${result.snapshotBlock} ` +
      `gaps=${gapIds.length} accountMarkets=${result.scopedAccountMarkets} ` +
      `collateralAccounts=${result.scopedCollateralAccounts} ` +
      `rpcRequests=${result.rpcRequestCount} changed=${result.changes.length} ` +
      `unchanged=${result.unchangedRows} metadataWrites=${result.metadataWrites} ` +
      `protectedNewer=${result.protectedNewerRows} failures=${result.failures.length}`,
  );
  if (result.failures.length > 0) process.exitCode = 1;
}

void main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Balance reconciliation failed',
    );
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
