-- Voucher Dispersal "Add more people" batches (platform/docs/plans/VOUCHER-DISPERSAL.md §10).
-- ADDITIVE: one enum, one table, new columns with constant defaults / nullable (metadata-only on PG 11+, no rewrite;
-- every existing row becomes batch 1). No data is changed or removed.
-- The ONE index change: the per-campaign unique (campaignId, rowNumber) is WIDENED to
-- (campaignId, batchNumber, rowNumber) — a later batch's file restarts at Excel row 2. The new index is
-- created FIRST, so a uniqueness guarantee holds at every moment; dropping the narrower index removes no data
-- (every existing row is batch 1, so the old guarantee is exactly preserved for them). Rollback = recreate it.
-- lock_timeout: a plain session SET (Prisma sends migration statements OUTSIDE a transaction block, so SET LOCAL is
-- ignored — verified 2026-11-18: Postgres logged "SET LOCAL can only be used in transaction blocks" when staging applied
-- 20261118130000). RESET at the end so the setting does not leak to later migrations in the same run.
-- RE-RUNNABLE (coordinator decision 2026-11-18): because the statements are not one transaction, a lock-timeout failure
-- can leave the earlier ones applied. Every statement is therefore idempotent (IF [NOT] EXISTS / guarded DO blocks), so
-- recovery is just `prisma migrate resolve --rolled-back 20261118160000_voucher_dispersal_batches` + `migrate deploy`.
SET lock_timeout = '5s';

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "VoucherDispersalBatchStatus" AS ENUM ('PREVIEWED', 'CONFIRMED', 'DISCARDED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "voucher_dispersal_rows" ADD COLUMN IF NOT EXISTS "batchNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS "lateCompletedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "supersededActiveRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN IF NOT EXISTS "supersededCheckedAt" TIMESTAMP(3);

-- AlterTable (settle-failure surfacing; constant defaults — metadata-only, no rewrite)
ALTER TABLE "voucher_dispersal_campaigns" ADD COLUMN IF NOT EXISTS "settleFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "settleError" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "voucher_dispersal_batches" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "batchNumber" INTEGER NOT NULL,
    "status" "VoucherDispersalBatchStatus" NOT NULL DEFAULT 'PREVIEWED',
    "previewId" TEXT,
    "sourceFileName" TEXT,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "discardedById" TEXT,
    "discardedAt" TIMESTAMP(3),
    "discardReason" TEXT,
    "skippedBlankRows" INTEGER,
    "skippedFormulaRows" INTEGER,
    "hiddenRowsIncluded" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voucher_dispersal_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "voucher_dispersal_batches_campaignId_batchNumber_key" ON "voucher_dispersal_batches"("campaignId", "batchNumber");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "voucher_dispersal_batches_campaignId_status_idx" ON "voucher_dispersal_batches"("campaignId", "status");

-- AddForeignKey (guarded: skipped when the constraint already exists)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_dispersal_batches_campaignId_fkey') THEN
    ALTER TABLE "voucher_dispersal_batches" ADD CONSTRAINT "voucher_dispersal_batches_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "voucher_dispersal_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- CreateIndex (widened per-batch row-number uniqueness; created before the narrower one is dropped)
CREATE UNIQUE INDEX IF NOT EXISTS "voucher_dispersal_rows_campaignId_batchNumber_rowNumber_key" ON "voucher_dispersal_rows"("campaignId", "batchNumber", "rowNumber");

-- DropIndex
DROP INDEX IF EXISTS "voucher_dispersal_rows_campaignId_rowNumber_key";

-- CreateIndex (the Daily Ops Digest counts "bought later after failing" by lateCompletedAt in its window)
CREATE INDEX IF NOT EXISTS "voucher_dispersal_rows_lateCompletedAt_idx" ON "voucher_dispersal_rows"("lateCompletedAt");

RESET lock_timeout;
