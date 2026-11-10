-- Sales Import hardening (audit fix round). Touches ONLY the two unreleased sales-import tables
-- created by 20261110120000_add_sales_import; no existing (pre-feature) table is altered.

-- M2: unique token per claim (the worker finalises only while its token is current).
ALTER TABLE "sales_imports" ADD COLUMN "claimToken" TEXT;
-- H2: fingerprint of the column mapping the import was processed under.
ALTER TABLE "sales_imports" ADD COLUMN "mappingFingerprint" TEXT;
-- M7: bumped every time the import becomes READY (ApplyRequest.processingVersion).
ALTER TABLE "sales_imports" ADD COLUMN "processingVersion" INTEGER NOT NULL DEFAULT 0;
-- FE: server time the import last entered QUEUED ("waiting > 2 min" notice).
ALTER TABLE "sales_imports" ADD COLUMN "queuedAt" TIMESTAMP(3);
-- S5: raw parts / unmatched.csv / aggregates / sample rows purged (retention).
ALTER TABLE "sales_imports" ADD COLUMN "purgedAt" TIMESTAMP(3);

-- H3: quantities are accumulated at 1e-12 (pico-cases) instead of 1e-6 so per-line rounding cannot drift
-- a monthly total. Existing rows (dev only; the feature is unreleased) are rescaled in place.
ALTER TABLE "sales_import_aggregates" RENAME COLUMN "qtyMicro" TO "qtyPico";
UPDATE "sales_import_aggregates" SET "qtyPico" = "qtyPico" * 1000000;

-- S5 retention sweep + per-tenant in-flight cap.
CREATE INDEX "sales_imports_status_finishedAt_idx" ON "sales_imports"("status", "finishedAt");
