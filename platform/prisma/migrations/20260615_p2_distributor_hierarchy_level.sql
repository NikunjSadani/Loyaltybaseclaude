-- P2 migration (dev DB only — gifsy_dev).
-- (2.4) Outlet gains two reference-only text columns, distributorCode + distributorName,
--       populated from the outlet upload file; used only for report grouping/summary.
--       No separate Distributor table (owner decision 2026-06-15).
-- (2.1 / RF4) SalesHierarchyLevel.level: replace the global unique with a tenant-scoped
--       unique (clientId, level) so two clients can each have their own level numbers.
-- Generated read-only via `prisma migrate diff` (HEAD schema -> edited schema).
-- Additive + safe: new nullable columns; the (clientId, level) unique cannot collide
-- because the prior GLOBAL unique on level guaranteed no duplicate levels anywhere.

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'Refusing to run P2 migration: expected database gifsy_dev, got %', current_database();
  END IF;
END $$;

-- DropIndex (old global unique on level)
DROP INDEX "sales_hierarchy_levels_level_key";

-- AlterTable
ALTER TABLE "outlets" ADD COLUMN     "distributorCode" TEXT,
ADD COLUMN     "distributorName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "sales_hierarchy_levels_clientId_level_key" ON "sales_hierarchy_levels"("clientId", "level");
CREATE INDEX "outlets_distributorCode_idx" ON "outlets"("distributorCode");

COMMIT;
