ALTER TABLE "IndexerState"
ADD COLUMN "lastSuccessfulPollAt" TIMESTAMP(3),
ADD COLUMN "consecutiveRpcFailures" INTEGER NOT NULL DEFAULT 0;

UPDATE "IndexerState"
SET "lastSuccessfulPollAt" = "updatedAt";
