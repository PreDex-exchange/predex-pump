-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "creator" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "ancillaryData" TEXT NOT NULL,
    "ancillaryDataHash" TEXT NOT NULL,
    "metadataHash" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'Opened',
    "conditionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "marketTypeVersion" INTEGER NOT NULL,
    "collateralAddress" TEXT,
    "collateralDecimals" INTEGER,
    "yesTokenId" TEXT,
    "noTokenId" TEXT,
    "seedRaw" TEXT NOT NULL DEFAULT '0',
    "yesPriceRaw" TEXT NOT NULL DEFAULT '500000',
    "noPriceRaw" TEXT NOT NULL DEFAULT '500000',
    "graduationActivityRaw" TEXT NOT NULL DEFAULT '0',
    "bookAddress" TEXT,
    "frozenYesPriceRaw" TEXT,
    "handoffSizeRaw" TEXT,
    "yesSeedOrderId" TEXT,
    "noSeedOrderId" TEXT,
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "volumeRaw" TEXT NOT NULL DEFAULT '0',
    "openingFeeRaw" TEXT NOT NULL DEFAULT '0',
    "seedFloorRaw" TEXT NOT NULL DEFAULT '0',
    "seedCapRaw" TEXT NOT NULL DEFAULT '0',
    "fCapRaw" TEXT NOT NULL DEFAULT '0',
    "graduationThresholdRaw" TEXT NOT NULL DEFAULT '0',
    "graduationTollRaw" TEXT NOT NULL DEFAULT '0',
    "inventoryTargetRaw" TEXT NOT NULL DEFAULT '0',
    "protocolFeeBps" INTEGER NOT NULL DEFAULT 0,
    "depthFeeBps" INTEGER NOT NULL DEFAULT 0,
    "tradingWindowSeconds" INTEGER NOT NULL DEFAULT 0,
    "minimumTimeOpenSeconds" INTEGER NOT NULL DEFAULT 0,
    "qYesRaw" TEXT NOT NULL DEFAULT '0',
    "qNoRaw" TEXT NOT NULL DEFAULT '0',
    "fundingCommittedRaw" TEXT NOT NULL DEFAULT '0',
    "bCurrentWad" TEXT NOT NULL DEFAULT '0',
    "inventoryYesRaw" TEXT NOT NULL DEFAULT '0',
    "inventoryNoRaw" TEXT NOT NULL DEFAULT '0',
    "lastSplitAmountRaw" TEXT NOT NULL DEFAULT '0',
    "lastMergeAmountRaw" TEXT NOT NULL DEFAULT '0',
    "createdAt" INTEGER NOT NULL,
    "tradingEndsAt" INTEGER NOT NULL DEFAULT 0,
    "graduatedAt" INTEGER,
    "resolvedAt" INTEGER,
    "closedOutAt" INTEGER,
    "indexedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "sizeRaw" TEXT NOT NULL,
    "priceRaw" TEXT NOT NULL,
    "costRaw" TEXT NOT NULL,
    "feeRaw" TEXT NOT NULL,
    "baseAmountRaw" TEXT NOT NULL,
    "protocolFeeRaw" TEXT NOT NULL,
    "depthContributionRaw" TEXT NOT NULL,
    "totalCostRaw" TEXT NOT NULL,
    "netProceedsRaw" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "ts" INTEGER NOT NULL,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricePoint" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "yesPriceRaw" TEXT NOT NULL,
    "noPriceRaw" TEXT NOT NULL,
    "qYesRaw" TEXT NOT NULL,
    "qNoRaw" TEXT NOT NULL,
    "bCurrentWad" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "ts" INTEGER NOT NULL,

    CONSTRAINT "PricePoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "orderId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "maker" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "priceRaw" TEXT NOT NULL,
    "sizeRaw" TEXT NOT NULL,
    "escrowRaw" TEXT NOT NULL,
    "filledRaw" TEXT NOT NULL DEFAULT '0',
    "remainingRaw" TEXT NOT NULL,
    "open" BOOLEAN NOT NULL DEFAULT true,
    "isSeed" BOOLEAN NOT NULL DEFAULT false,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "createdAt" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("orderId")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "taker" TEXT NOT NULL,
    "maker" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "fillSizeRaw" TEXT NOT NULL,
    "paymentRaw" TEXT NOT NULL,
    "filledAfterRaw" TEXT NOT NULL,
    "openAfter" BOOLEAN NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "ts" INTEGER NOT NULL,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "account" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "qtyRaw" TEXT NOT NULL DEFAULT '0',
    "costBasisRaw" TEXT NOT NULL DEFAULT '0',
    "costBasisEstimated" BOOLEAN NOT NULL DEFAULT true,
    "realizedPnlRaw" TEXT NOT NULL DEFAULT '0',
    "unrealizedPnlRaw" TEXT NOT NULL DEFAULT '0',
    "updatedAt" INTEGER NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("account","marketId","outcome")
);

-- CreateTable
CREATE TABLE "Resolution" (
    "marketId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "payoutYes" INTEGER NOT NULL,
    "payoutNo" INTEGER NOT NULL,
    "denominator" INTEGER NOT NULL,
    "resolvedAt" INTEGER NOT NULL,
    "observedAt" INTEGER,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,

    CONSTRAINT "Resolution_pkey" PRIMARY KEY ("marketId")
);

-- CreateTable
CREATE TABLE "Closeout" (
    "marketId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "payoutYes" TEXT NOT NULL,
    "payoutNo" TEXT NOT NULL,
    "userTerminalClaimRaw" TEXT NOT NULL,
    "netBaseTradeCollectedRaw" TEXT NOT NULL,
    "fundingLossRaw" TEXT NOT NULL,
    "fundingResidualRaw" TEXT NOT NULL,
    "protocolPnlRaw" TEXT NOT NULL,
    "protocolFeesRaw" TEXT NOT NULL,
    "redeemedYesRaw" TEXT NOT NULL,
    "redeemedNoRaw" TEXT NOT NULL,
    "closedOutAt" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,

    CONSTRAINT "Closeout_pkey" PRIMARY KEY ("marketId")
);

-- CreateTable
CREATE TABLE "Account" (
    "address" TEXT NOT NULL,
    "firstSeenAt" INTEGER NOT NULL,
    "marketsCreated" INTEGER NOT NULL DEFAULT 0,
    "tradeCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "marketId" TEXT,
    "account" TEXT,
    "outcome" TEXT,
    "side" TEXT,
    "amountRaw" TEXT,
    "priceRaw" TEXT,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "ts" INTEGER NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistryConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "chainId" INTEGER NOT NULL,
    "usdcAddress" TEXT NOT NULL,
    "ctfAddress" TEXT NOT NULL,
    "oracleAddress" TEXT NOT NULL,
    "lmsrAddress" TEXT NOT NULL,
    "registryAddress" TEXT NOT NULL,
    "miniClobAddress" TEXT NOT NULL,
    "marketTypeVersion" INTEGER NOT NULL DEFAULT 0,
    "currentLmsrAddress" TEXT NOT NULL,
    "openingFeeRaw" TEXT NOT NULL DEFAULT '0',
    "seedFloorRaw" TEXT NOT NULL DEFAULT '0',
    "seedCapRaw" TEXT NOT NULL DEFAULT '0',
    "fCapRaw" TEXT NOT NULL DEFAULT '0',
    "singleTopUpCapRaw" TEXT NOT NULL DEFAULT '0',
    "graduationMoneyInThresholdRaw" TEXT NOT NULL DEFAULT '0',
    "graduationTollRaw" TEXT NOT NULL DEFAULT '0',
    "inventoryTargetRaw" TEXT NOT NULL DEFAULT '0',
    "inventoryLowRaw" TEXT NOT NULL DEFAULT '0',
    "inventoryHighRaw" TEXT NOT NULL DEFAULT '0',
    "freeCollateralBufferRaw" TEXT NOT NULL DEFAULT '0',
    "defaultTradingWindowSeconds" INTEGER NOT NULL DEFAULT 0,
    "minTradingWindowSeconds" INTEGER NOT NULL DEFAULT 0,
    "maxTradingWindowSeconds" INTEGER NOT NULL DEFAULT 0,
    "minimumTimeOpenSeconds" INTEGER NOT NULL DEFAULT 0,
    "protocolFeeBps" INTEGER NOT NULL DEFAULT 0,
    "depthFeeBps" INTEGER NOT NULL DEFAULT 0,
    "committeeThreshold" INTEGER NOT NULL DEFAULT 0,
    "updatedBlock" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistryConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegisteredMarketType" (
    "version" INTEGER NOT NULL,
    "lmsrAddress" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "registeredAt" INTEGER NOT NULL,
    "blockNumber" INTEGER NOT NULL,

    CONSTRAINT "RegisteredMarketType_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "CommitteeMember" (
    "address" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "addedAt" INTEGER NOT NULL,
    "removedAt" INTEGER,
    "updatedBlock" INTEGER NOT NULL,

    CONSTRAINT "CommitteeMember_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "IndexerState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "chainId" INTEGER NOT NULL,
    "deployBlock" INTEGER NOT NULL,
    "lastBlock" INTEGER NOT NULL,
    "headBlock" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Market_conditionId_key" ON "Market"("conditionId");

-- CreateIndex
CREATE UNIQUE INDEX "Market_yesTokenId_key" ON "Market"("yesTokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Market_noTokenId_key" ON "Market"("noTokenId");

-- CreateIndex
CREATE INDEX "Market_phase_idx" ON "Market"("phase");

-- CreateIndex
CREATE INDEX "Market_creator_idx" ON "Market"("creator");

-- CreateIndex
CREATE INDEX "Market_createdAt_idx" ON "Market"("createdAt");

-- CreateIndex
CREATE INDEX "Market_questionId_idx" ON "Market"("questionId");

-- CreateIndex
CREATE INDEX "Trade_marketId_ts_idx" ON "Trade"("marketId", "ts");

-- CreateIndex
CREATE INDEX "Trade_account_ts_idx" ON "Trade"("account", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_txHash_logIndex_key" ON "Trade"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "PricePoint_marketId_ts_idx" ON "PricePoint"("marketId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "PricePoint_txHash_logIndex_key" ON "PricePoint"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "Order_marketId_outcome_open_idx" ON "Order"("marketId", "outcome", "open");

-- CreateIndex
CREATE INDEX "Order_tokenId_open_idx" ON "Order"("tokenId", "open");

-- CreateIndex
CREATE INDEX "Order_maker_idx" ON "Order"("maker");

-- CreateIndex
CREATE INDEX "Fill_marketId_ts_idx" ON "Fill"("marketId", "ts");

-- CreateIndex
CREATE INDEX "Fill_taker_ts_idx" ON "Fill"("taker", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "Fill_txHash_logIndex_key" ON "Fill"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "Position_account_idx" ON "Position"("account");

-- CreateIndex
CREATE INDEX "ActivityEvent_ts_idx" ON "ActivityEvent"("ts");

-- CreateIndex
CREATE INDEX "ActivityEvent_marketId_ts_idx" ON "ActivityEvent"("marketId", "ts");

-- CreateIndex
CREATE INDEX "ActivityEvent_account_ts_idx" ON "ActivityEvent"("account", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityEvent_txHash_logIndex_key" ON "ActivityEvent"("txHash", "logIndex");

-- CreateIndex
CREATE INDEX "CommitteeMember_active_idx" ON "CommitteeMember"("active");

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricePoint" ADD CONSTRAINT "PricePoint_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("orderId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Resolution" ADD CONSTRAINT "Resolution_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Closeout" ADD CONSTRAINT "Closeout_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
