CREATE TABLE "IndexerGap" (
    "id" SERIAL NOT NULL,
    "chainId" INTEGER NOT NULL,
    "skippedFromBlock" INTEGER NOT NULL,
    "skippedToBlock" INTEGER NOT NULL,
    "skippedBlockCount" INTEGER NOT NULL,
    "cursorBefore" INTEGER NOT NULL,
    "cursorAfter" INTEGER NOT NULL,
    "headBlock" INTEGER NOT NULL,
    "startPolicy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "maxBackfillBlocks" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexerGap_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IndexerGap_recordedAt_id_idx"
ON "IndexerGap"("recordedAt" DESC, "id" DESC);
