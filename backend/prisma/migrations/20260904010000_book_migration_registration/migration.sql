-- Durable CTFExchange registration checkpoints share the existing per-market
-- BookMigration state machine without introducing a second job or queue.
ALTER TABLE "BookMigration"
ADD COLUMN "registrationStatus" TEXT NOT NULL DEFAULT 'UNCHECKED',
ADD COLUMN "registrationTxHash" TEXT,
ADD COLUMN "registrationBlockNumber" INTEGER;

-- The previous worker could fail only at publication with this code, after
-- replacements were staged and both seed orders were already closed. Requeue
-- precisely those rows; preserve their failure audit until registration lands.
UPDATE "BookMigration"
SET
  "status" = 'STAGED',
  "nextAttemptAt" = 0,
  "claimToken" = NULL,
  "claimExpiresAt" = NULL
WHERE
  "status" = 'FAILED'
  AND "lastFailureCode" = 'TOKEN_NOT_REGISTERED';
