-- Voucher Dispersal "Add more people" batches (platform/docs/plans/VOUCHER-DISPERSAL.md §10).
-- ADDITIVE: one enum, one table, one column with a constant default (metadata-only on PG 11+, no rewrite;
-- every existing row becomes batch 1). No data is changed or removed.
-- The ONE index change: the per-campaign unique (campaignId, rowNumber) is WIDENED to
-- (campaignId, batchNumber, rowNumber) — a later batch's file restarts at Excel row 2. The new index is
-- created FIRST, so a uniqueness guarantee holds at every moment; dropping the narrower index removes no data
-- (every existing row is batch 1, so the old guarantee is exactly preserved for them). Rollback = recreate it.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "VoucherDispersalBatchStatus" AS ENUM ('PREVIEWED', 'CONFIRMED', 'DISCARDED');

-- AlterTable
ALTER TABLE "voucher_dispersal_rows" ADD COLUMN "batchNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "voucher_dispersal_batches" (
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voucher_dispersal_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voucher_dispersal_batches_campaignId_batchNumber_key" ON "voucher_dispersal_batches"("campaignId", "batchNumber");

-- CreateIndex
CREATE INDEX "voucher_dispersal_batches_campaignId_status_idx" ON "voucher_dispersal_batches"("campaignId", "status");

-- AddForeignKey
ALTER TABLE "voucher_dispersal_batches" ADD CONSTRAINT "voucher_dispersal_batches_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "voucher_dispersal_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex (widened per-batch row-number uniqueness; created before the narrower one is dropped)
CREATE UNIQUE INDEX "voucher_dispersal_rows_campaignId_batchNumber_rowNumber_key" ON "voucher_dispersal_rows"("campaignId", "batchNumber", "rowNumber");

-- DropIndex
DROP INDEX "voucher_dispersal_rows_campaignId_rowNumber_key";
