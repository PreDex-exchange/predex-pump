-- Maintained account PnL totals replace per-request aggregation.
ALTER TABLE "Account"
ADD COLUMN "realizedPnlRaw" TEXT NOT NULL DEFAULT '0',
ADD COLUMN "unrealizedPnlRaw" TEXT NOT NULL DEFAULT '0';

UPDATE "Account" AS account
SET
  "realizedPnlRaw" = totals.realized,
  "unrealizedPnlRaw" = totals.unrealized
FROM (
  SELECT
    "account",
    COALESCE(SUM(("realizedPnlRaw")::numeric), 0)::text AS realized,
    COALESCE(SUM(("unrealizedPnlRaw")::numeric), 0)::text AS unrealized
  FROM "Position"
  GROUP BY "account"
) AS totals
WHERE account."address" = totals."account";

-- Replace single-column or mismatched-sort indexes with the query tuples used
-- by the REST contract and the set-based indexer rollup maintenance.
DROP INDEX "Market_phase_idx";
DROP INDEX "Market_creator_idx";
DROP INDEX "Market_createdAt_idx";
DROP INDEX "Trade_marketId_ts_idx";
DROP INDEX "Trade_account_ts_idx";
DROP INDEX "PricePoint_marketId_ts_idx";
DROP INDEX "Order_marketId_outcome_open_idx";
DROP INDEX "Position_account_idx";
DROP INDEX "ActivityEvent_ts_idx";
DROP INDEX "ActivityEvent_marketId_ts_idx";
DROP INDEX "ActivityEvent_account_ts_idx";

CREATE INDEX "Market_createdAt_id_idx"
ON "Market"("createdAt" DESC, "id" DESC);

CREATE INDEX "Market_phase_createdAt_id_idx"
ON "Market"("phase", "createdAt" DESC, "id" DESC);

CREATE INDEX "Market_creator_createdAt_id_idx"
ON "Market"("creator", "createdAt" DESC, "id" DESC);

CREATE INDEX "Market_phase_creator_createdAt_id_idx"
ON "Market"("phase", "creator", "createdAt" DESC, "id" DESC);

CREATE INDEX "Trade_marketId_blockNumber_logIndex_idx"
ON "Trade"("marketId", "blockNumber" DESC, "logIndex" DESC);

CREATE INDEX "Trade_account_blockNumber_logIndex_idx"
ON "Trade"("account", "blockNumber" DESC, "logIndex" DESC);

CREATE INDEX "PricePoint_marketId_ts_blockNumber_logIndex_idx"
ON "PricePoint"("marketId", "ts", "blockNumber", "logIndex");

CREATE INDEX "Order_marketId_open_idx"
ON "Order"("marketId", "open");

CREATE INDEX "Position_account_updatedAt_marketId_outcome_idx"
ON "Position"("account", "updatedAt" DESC, "marketId" DESC, "outcome");

CREATE INDEX "Position_marketId_outcome_account_idx"
ON "Position"("marketId", "outcome", "account");

CREATE INDEX "ActivityEvent_blockNumber_logIndex_idx"
ON "ActivityEvent"("blockNumber" DESC, "logIndex" DESC);

CREATE INDEX "ActivityEvent_marketId_blockNumber_logIndex_idx"
ON "ActivityEvent"("marketId", "blockNumber" DESC, "logIndex" DESC);

CREATE INDEX "ActivityEvent_account_blockNumber_logIndex_idx"
ON "ActivityEvent"("account", "blockNumber" DESC, "logIndex" DESC);

CREATE INDEX "ActivityEvent_marketId_account_blockNumber_logIndex_idx"
ON "ActivityEvent"("marketId", "account", "blockNumber" DESC, "logIndex" DESC);
