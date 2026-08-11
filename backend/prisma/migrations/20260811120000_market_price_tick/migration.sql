-- Per-market off-chain price policy. CTFExchange remains unchanged.
ALTER TABLE "Market"
ADD COLUMN "minimumTickSizeRaw" TEXT NOT NULL DEFAULT '1000';

-- Snapshot the migration policy and both price/size adjustments for audit.
ALTER TABLE "BookMigration"
ADD COLUMN "minimumTickSizeRaw" TEXT,
ADD COLUMN "yesRealizedPriceRaw" TEXT,
ADD COLUMN "noRealizedPriceRaw" TEXT,
ADD COLUMN "yesPriceDeviationRaw" TEXT,
ADD COLUMN "noPriceDeviationRaw" TEXT,
ADD COLUMN "yesReplacementSizeRaw" TEXT,
ADD COLUMN "noReplacementSizeRaw" TEXT,
ADD COLUMN "yesUnquotedRemainderRaw" TEXT,
ADD COLUMN "noUnquotedRemainderRaw" TEXT;
