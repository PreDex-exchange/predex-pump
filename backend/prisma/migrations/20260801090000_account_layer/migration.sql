-- Additive off-chain identity, session, watchlist, and deliberately modest behavior state.
CREATE TABLE "UserAccount" (
    "address" TEXT NOT NULL,
    "displayName" TEXT,
    "rememberRecentlyViewed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserAccount_pkey" PRIMARY KEY ("address")
);

CREATE TABLE "SiweNonce" (
    "nonce" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    CONSTRAINT "SiweNonce_pkey" PRIMARY KEY ("nonce")
);

CREATE TABLE "AuthSession" (
    "tokenHash" TEXT NOT NULL,
    "accountAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("tokenHash")
);

CREATE TABLE "AccountWatchlist" (
    "accountAddress" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountWatchlist_pkey" PRIMARY KEY ("accountAddress", "marketId")
);

CREATE TABLE "AccountBehaviorEvent" (
    "id" TEXT NOT NULL,
    "accountAddress" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccountBehaviorEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SiweNonce_expiresAt_idx" ON "SiweNonce"("expiresAt");
CREATE INDEX "AuthSession_accountAddress_expiresAt_idx" ON "AuthSession"("accountAddress", "expiresAt");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
CREATE INDEX "AccountWatchlist_marketId_idx" ON "AccountWatchlist"("marketId");
CREATE UNIQUE INDEX "AccountBehaviorEvent_accountAddress_type_marketId_key" ON "AccountBehaviorEvent"("accountAddress", "type", "marketId");
CREATE INDEX "AccountBehaviorEvent_accountAddress_occurredAt_idx" ON "AccountBehaviorEvent"("accountAddress", "occurredAt" DESC);

ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_accountAddress_fkey" FOREIGN KEY ("accountAddress") REFERENCES "UserAccount"("address") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountWatchlist" ADD CONSTRAINT "AccountWatchlist_accountAddress_fkey" FOREIGN KEY ("accountAddress") REFERENCES "UserAccount"("address") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountBehaviorEvent" ADD CONSTRAINT "AccountBehaviorEvent_accountAddress_fkey" FOREIGN KEY ("accountAddress") REFERENCES "UserAccount"("address") ON DELETE CASCADE ON UPDATE CASCADE;
