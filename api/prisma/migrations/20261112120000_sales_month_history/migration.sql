-- Sales Import month history (owner decision 2026-11-10) + re-check fixes (per-run unmatched.csv key, one live re-import): the FINAL applied file lines of every month, kept 10 years,
-- so a month can be recalculated after the per-import aggregates are purged (30 days). Additive: one new table + one
-- defaulted column on the (unreleased) sales_import_applies table.

-- CreateTable
CREATE TABLE "sales_month_histories" (
    "id" BIGSERIAL NOT NULL,
    "clientId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "outletId" TEXT,
    "dims" JSONB NOT NULL,
    "dimKey" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "qtyPico" BIGINT NOT NULL,
    "lines" INTEGER NOT NULL,
    "sourceImportId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL,
    "appliedById" TEXT NOT NULL,

    CONSTRAINT "sales_month_histories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_month_histories_clientId_month_customerCode_dimKey_key" ON "sales_month_histories"("clientId", "month", "customerCode", "dimKey");
CREATE INDEX "sales_month_histories_clientId_month_id_idx" ON "sales_month_histories"("clientId", "month", "id");
CREATE INDEX "sales_month_histories_month_idx" ON "sales_month_histories"("month");

-- 'IMPORT' (a file applied) | 'HISTORY' (POST admin/sales-months/:month/recalculate)
ALTER TABLE "sales_import_applies" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'IMPORT';

-- Re-check M1: the unmatched.csv object is per processing run; the READY transaction stores its key here.
ALTER TABLE "sales_imports" ADD COLUMN "unmatchedCsvKey" TEXT;

-- Re-check M3: at most ONE live "reprocess as new" child per applied import (raw partial unique index; Prisma does not
-- model partial indexes). CANCELLED / FAILED children do not count, so a retry after a failure is allowed.
CREATE UNIQUE INDEX "sales_imports_reprocessedFromId_live_key" ON "sales_imports"("reprocessedFromId")
  WHERE "reprocessedFromId" IS NOT NULL AND "status" NOT IN ('CANCELLED', 'FAILED');
