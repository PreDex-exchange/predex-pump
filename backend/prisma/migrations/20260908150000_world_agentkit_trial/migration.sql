-- World AgentKit free uses and replay protection are durable authorization
-- state. Redis remains disposable and is never authoritative for either.
CREATE TABLE "AgentkitTrialUsage" (
    "scope" TEXT NOT NULL,
    "humanKey" TEXT NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentkitTrialUsage_pkey" PRIMARY KEY ("scope", "humanKey")
);

CREATE TABLE "AgentkitTrialNonce" (
    "nonceKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "humanKey" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentkitTrialNonce_pkey" PRIMARY KEY ("nonceKey")
);

CREATE INDEX "AgentkitTrialNonce_scope_humanKey_idx"
ON "AgentkitTrialNonce"("scope", "humanKey");
