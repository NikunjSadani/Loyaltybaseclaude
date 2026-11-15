-- FOCUS-FROM-TARGETS (platform/docs/plans/FOCUS-FROM-TARGETS-DESIGN.md §8): a Sales Import KPI can take its products
-- per outlet from the month's target file, and an operator can accept an unmatched focus product as "not sold yet".
-- Additive; touches only sales-import tables. Every existing definition backfills to 'FILTER' (original behaviour), so
-- every tenant is unchanged until a definition is set to 'TARGET_NAMES'. (clientId, month) reads use the unique index's
-- leading columns, so no separate (clientId, month) index.

-- AlterTable
ALTER TABLE "sales_kpi_definitions" ADD COLUMN "productSource" TEXT NOT NULL DEFAULT 'FILTER';

-- CreateTable
CREATE TABLE "sales_focus_acceptances" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "kpiCode" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "acceptedById" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_focus_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_focus_acceptances_clientId_month_kpiCode_key_key" ON "sales_focus_acceptances"("clientId", "month", "kpiCode", "key");
