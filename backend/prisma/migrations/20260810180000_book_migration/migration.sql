-- Durable, once-only migration of graduated MiniCLOB seed liquidity into the
-- signed CTFExchange book. STAGED orders are deliberately outside the active
-- status set until the cancel/approval chain state has been confirmed.
ALTER TABLE "SignedOrder"
ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'USER';

CREATE TABLE "BookMigration" (
    "marketId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "yesSeedOrderId" TEXT NOT NULL,
    "noSeedOrderId" TEXT NOT NULL,
    "snapshotBlockNumber" INTEGER,
    "snapshotNonceRaw" TEXT,
    "yesPriceRaw" TEXT,
    "noPriceRaw" TEXT,
    "yesSnapshotRemainingRaw" TEXT,
    "noSnapshotRemainingRaw" TEXT,
    "yesRecoveredRaw" TEXT,
    "noRecoveredRaw" TEXT,
    "yesReplacementOrderHash" TEXT,
    "noReplacementOrderHash" TEXT,
    "approvalStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
    "approvalTxHash" TEXT,
    "approvalBlockNumber" INTEGER,
    "yesCancelStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
    "noCancelStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
    "yesCancelTxHash" TEXT,
    "noCancelTxHash" TEXT,
    "activeCancelOutcome" TEXT,
    "cancelBlockNumber" INTEGER,
    "recoveryBlockNumber" INTEGER,
    "yesBalanceRaw" TEXT,
    "noBalanceRaw" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "claimExpiresAt" INTEGER,
    "lastFailureCode" TEXT,
    "lastFailureMessage" TEXT,
    "lastFailureAt" INTEGER,
    "createdAt" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,
    "cancelledAt" INTEGER,
    "migratedAt" INTEGER,
    CONSTRAINT "BookMigration_pkey" PRIMARY KEY ("marketId")
);

CREATE INDEX "SignedOrder_origin_marketId_idx"
ON "SignedOrder"("origin", "marketId");
CREATE INDEX "BookMigration_status_nextAttemptAt_createdAt_idx"
ON "BookMigration"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "BookMigration_claimExpiresAt_idx"
ON "BookMigration"("claimExpiresAt");
CREATE INDEX "BookMigration_yesReplacementOrderHash_idx"
ON "BookMigration"("yesReplacementOrderHash");
CREATE INDEX "BookMigration_noReplacementOrderHash_idx"
ON "BookMigration"("noReplacementOrderHash");

ALTER TABLE "BookMigration"
ADD CONSTRAINT "BookMigration_marketId_fkey"
FOREIGN KEY ("marketId") REFERENCES "Market"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
