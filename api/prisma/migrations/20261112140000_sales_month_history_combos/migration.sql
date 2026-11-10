-- Sales Import extras (plan §10c, audit M1): a small per-month product-combo summary of the stored month history, so
-- the KPI picker's "Stored month(s)" source never scans the line rows. Additive; touches only sales-import tables.
-- Each row records the history set it summarises (sourceImportId + appliedAt = the set header's): a reader that finds
-- them different from the header (e.g. an apply by an older revision during a deploy) rebuilds that month (re-check L-a).

-- CreateTable
CREATE TABLE "sales_month_history_combos" (
    "id" BIGSERIAL NOT NULL,
    "clientId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "dims" JSONB NOT NULL,
    "dimKey" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "amountPaise" DECIMAL(38,0) NOT NULL,
    "qtyPico" DECIMAL(38,0) NOT NULL,
    "lines" INTEGER NOT NULL,
    "sourceImportId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_month_history_combos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_month_history_combos_clientId_month_keyHash_key" ON "sales_month_history_combos"("clientId", "month", "keyHash");

-- CreateIndex
CREATE INDEX "sales_month_history_combos_month_idx" ON "sales_month_history_combos"("month");

-- Backfill every month already stored (same statement shape as the apply write). dimKey is the stable key of dims
-- (1:1), and every line of a month carries the same sourceImportId / appliedAt (one set per month).
INSERT INTO "sales_month_history_combos"
  ("clientId", "month", "dims", "dimKey", "keyHash", "amountPaise", "qtyPico", "lines", "sourceImportId", "appliedAt")
SELECT h."clientId", h."month", h."dims", h."dimKey", md5(h."dimKey"),
       SUM(h."amountPaise"), SUM(h."qtyPico"), SUM(h."lines")::int, h."sourceImportId", h."appliedAt"
  FROM "sales_month_histories" h
 GROUP BY h."clientId", h."month", h."dimKey", h."dims", h."sourceImportId", h."appliedAt";
