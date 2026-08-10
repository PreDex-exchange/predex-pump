CREATE TABLE "IndexerSubscriptionState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'polling',
    "headBlock" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerSubscriptionState_pkey" PRIMARY KEY ("id")
);
