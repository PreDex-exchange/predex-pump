ALTER TABLE "RegistryConfig"
ADD COLUMN "updatedLogIndex" INTEGER NOT NULL DEFAULT -1;

ALTER TABLE "RegisteredMarketType"
ADD COLUMN "logIndex" INTEGER NOT NULL DEFAULT -1;

ALTER TABLE "CommitteeMember"
ADD COLUMN "updatedLogIndex" INTEGER NOT NULL DEFAULT -1;

ALTER TABLE "IndexerState"
ADD COLUMN "chainStateBootstrapStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN "chainStateBootstrapAttemptedBlock" INTEGER,
ADD COLUMN "chainStateBootstrapBlock" INTEGER,
ADD COLUMN "chainStateBootstrapAttemptedAt" TIMESTAMP(3),
ADD COLUMN "chainStateBootstrappedAt" TIMESTAMP(3),
ADD COLUMN "chainStateBootstrapError" TEXT;
