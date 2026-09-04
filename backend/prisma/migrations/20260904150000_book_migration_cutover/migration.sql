-- A coordinated MiniCLOB cutover replaces the two seed-by-seed cancellation
-- submissions. The hash is durable so receipt polling survives restarts.
ALTER TABLE "BookMigration"
ADD COLUMN "cutoverTxHash" TEXT;
