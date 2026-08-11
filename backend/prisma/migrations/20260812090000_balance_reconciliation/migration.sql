ALTER TABLE "Position"
ADD COLUMN "balanceReconciledBlock" INTEGER;

ALTER TABLE "IndexerGap"
ADD COLUMN "balanceReconciliationStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN "balanceReconciliationBlock" INTEGER,
ADD COLUMN "balanceReconciliationAttemptedAt" TIMESTAMP(3),
ADD COLUMN "balanceReconciledAt" TIMESTAMP(3),
ADD COLUMN "balanceReconciliationError" TEXT;

CREATE INDEX "IndexerGap_balanceReconciliationStatus_recordedAt_id_idx"
ON "IndexerGap"("balanceReconciliationStatus", "recordedAt" ASC, "id" ASC);
