-- Sales Import extras (plan §10c, audit M1): a small per-month product-combo summary of the stored month history, so
-- the KPI picker's "Stored month(s)" source never scans the line rows. Additive; touches only sales-import tables.

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

    CONSTRAINT "sales_month_history_combos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_month_history_combos_clientId_month_keyHash_key" ON "sales_month_history_combos"("clientId", "month", "keyHash");

-- CreateIndex
CREATE INDEX "sales_month_history_combos_month_idx" ON "sales_month_history_combos"("month");

-- Backfill every month already stored (same statement shape as the apply write). Within one month every line comes
-- from ONE import read with ONE mapping, so dimKey ↔ dims is 1:1; grouping by dimKey alone (dims = any of its rows)
-- keeps the unique key safe even if that ever did not hold.
INSERT INTO "sales_month_history_combos" ("clientId", "month", "dims", "dimKey", "keyHash", "amountPaise", "qtyPico", "lines")
SELECT h."clientId", h."month", (array_agg(h."dims"))[1], h."dimKey", md5(h."dimKey"),
       SUM(h."amountPaise"), SUM(h."qtyPico"), SUM(h."lines")::int
  FROM "sales_month_histories" h
 GROUP BY h."clientId", h."month", h."dimKey";
