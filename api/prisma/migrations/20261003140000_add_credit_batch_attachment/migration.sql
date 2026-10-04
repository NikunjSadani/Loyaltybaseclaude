-- B1 — audit-evidence attachments on a credit/payout batch.
-- Stores the client's offline visibility-audit photos/PDFs in-portal as the record behind a
-- 194C visibility payout. Fully ADDITIVE: a new table only, no change to any existing table or
-- money row. `outletCode` is nullable + reserved (no current UI) so a future per-outlet
-- surfacing needs no migration. The FK cascades so deleting a batch drops its evidence rows
-- (the GCS objects are cleaned up by the application / bucket lifecycle, not the DB).

CREATE TABLE "credit_batch_attachments" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "outletCode" TEXT,
    "fileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_batch_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "credit_batch_attachments_clientId_batchId_idx" ON "credit_batch_attachments"("clientId", "batchId");

ALTER TABLE "credit_batch_attachments" ADD CONSTRAINT "credit_batch_attachments_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "credit_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
