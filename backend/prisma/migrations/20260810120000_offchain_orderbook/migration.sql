-- Signed CTFExchange order book and its compact indexed fillability state.
CREATE TABLE "SignedOrder" (
    "orderHash" TEXT NOT NULL,
    "saltRaw" TEXT NOT NULL,
    "maker" TEXT NOT NULL,
    "signer" TEXT NOT NULL,
    "taker" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "makerAmountRaw" TEXT NOT NULL,
    "takerAmountRaw" TEXT NOT NULL,
    "expiration" INTEGER NOT NULL,
    "nonceRaw" TEXT NOT NULL,
    "feeRateBpsRaw" TEXT NOT NULL,
    "exchangeSide" INTEGER NOT NULL,
    "signatureType" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "priceRaw" TEXT NOT NULL,
    "sizeRaw" TEXT NOT NULL,
    "filledRaw" TEXT NOT NULL DEFAULT '0',
    "remainingRaw" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "withdrawnAt" INTEGER,
    "lastFailureCode" TEXT,
    "lastFailureMessage" TEXT,
    "lastFailureAt" INTEGER,
    "lastOnchainTxHash" TEXT,
    "lastOnchainBlock" INTEGER,
    "createdAt" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,
    CONSTRAINT "SignedOrder_pkey" PRIMARY KEY ("orderHash")
);

CREATE TABLE "ExchangeTokenRegistration" (
    "tokenId" TEXT NOT NULL,
    "complementTokenId" TEXT NOT NULL,
    "conditionId" TEXT NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "registeredAt" INTEGER NOT NULL,
    CONSTRAINT "ExchangeTokenRegistration_pkey" PRIMARY KEY ("tokenId")
);

CREATE TABLE "CtfExchangeApproval" (
    "owner" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,
    CONSTRAINT "CtfExchangeApproval_pkey" PRIMARY KEY ("owner")
);

CREATE TABLE "CollateralExchangeApproval" (
    "owner" TEXT NOT NULL,
    "allowanceRaw" TEXT NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,
    CONSTRAINT "CollateralExchangeApproval_pkey" PRIMARY KEY ("owner")
);

CREATE TABLE "CollateralBalance" (
    "owner" TEXT NOT NULL,
    "balanceRaw" TEXT NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,
    CONSTRAINT "CollateralBalance_pkey" PRIMARY KEY ("owner")
);

CREATE TABLE "SettlementMatch" (
    "id" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "takerOrderHash" TEXT NOT NULL,
    "makerOrderHash" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "fillSizeRaw" TEXT NOT NULL,
    "takerFilledBeforeRaw" TEXT NOT NULL,
    "makerFilledBeforeRaw" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "txHash" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,
    CONSTRAINT "SettlementMatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SignedOrder_marketId_status_withdrawnAt_idx" ON "SignedOrder"("marketId", "status", "withdrawnAt");
CREATE INDEX "SignedOrder_tokenId_status_withdrawnAt_idx" ON "SignedOrder"("tokenId", "status", "withdrawnAt");
CREATE INDEX "SignedOrder_maker_status_withdrawnAt_idx" ON "SignedOrder"("maker", "status", "withdrawnAt");
CREATE INDEX "SignedOrder_expiration_idx" ON "SignedOrder"("expiration");
CREATE INDEX "ExchangeTokenRegistration_conditionId_idx" ON "ExchangeTokenRegistration"("conditionId");
CREATE UNIQUE INDEX "SettlementMatch_matchKey_key" ON "SettlementMatch"("matchKey");
CREATE INDEX "SettlementMatch_status_createdAt_idx" ON "SettlementMatch"("status", "createdAt");
CREATE INDEX "SettlementMatch_txHash_idx" ON "SettlementMatch"("txHash");
CREATE INDEX "SettlementMatch_takerOrderHash_idx" ON "SettlementMatch"("takerOrderHash");
CREATE INDEX "SettlementMatch_makerOrderHash_idx" ON "SettlementMatch"("makerOrderHash");

ALTER TABLE "SignedOrder" ADD CONSTRAINT "SignedOrder_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SettlementMatch" ADD CONSTRAINT "SettlementMatch_takerOrderHash_fkey" FOREIGN KEY ("takerOrderHash") REFERENCES "SignedOrder"("orderHash") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SettlementMatch" ADD CONSTRAINT "SettlementMatch_makerOrderHash_fkey" FOREIGN KEY ("makerOrderHash") REFERENCES "SignedOrder"("orderHash") ON DELETE RESTRICT ON UPDATE CASCADE;
