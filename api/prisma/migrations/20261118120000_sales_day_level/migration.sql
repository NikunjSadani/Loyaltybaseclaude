-- Sales Import day-level storage (owner decision 2026-11-18). ADDITIVE ONLY: two new tables + two nullable JSON columns
-- on the sales-import tables. No data is changed or deleted here, and the release changes no retention by itself (the
-- new windows apply only with SALES_RETENTION_V2=on, after the owner-gated one-off trim:
-- src/sales-import/oneoff/sales-history-trim.main.ts; runbook in SALES-IMPORT-PIPELINE-PLAN.md §17b).

-- Fail fast instead of queueing behind a long transaction on the live sales tables (the ALTERs below take an ACCESS
-- EXCLUSIVE lock, briefly): a lock not obtained within 5 s aborts the migration, which is simply re-run.
SET lock_timeout = '5s';

-- Per-outlet, per-IST-invoice-day month-to-date KPI values (sparse: only days the outlet billed something).
CREATE TABLE "outlet_sales_days" (
    "id" BIGSERIAL NOT NULL,
    "clientId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "outletCode" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "mtdValues" JSONB NOT NULL,
    "sourceImportId" TEXT NOT NULL,

    CONSTRAINT "outlet_sales_days_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outlet_sales_days_clientId_outletId_month_day_key" ON "outlet_sales_days"("clientId", "outletId", "month", "day");
CREATE INDEX "outlet_sales_days_clientId_month_day_idx" ON "outlet_sales_days"("clientId", "month", "day");

-- One row per tenant × month that has COMPLETE day data.
CREATE TABLE "sales_day_sets" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "lastDay" INTEGER NOT NULL,
    "sourceImportId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_day_sets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_day_sets_clientId_month_key" ON "sales_day_sets"("clientId", "month");

-- The day split of each per-import aggregate row and of each stored month-history line ([[day,"paise","pico",lines],…]).
-- Nullable, no default: a metadata-only change in Postgres (no table rewrite). Null = written before day-level storage.
ALTER TABLE "sales_import_aggregates" ADD COLUMN "days" JSONB;
ALTER TABLE "sales_month_histories" ADD COLUMN "days" JSONB;
