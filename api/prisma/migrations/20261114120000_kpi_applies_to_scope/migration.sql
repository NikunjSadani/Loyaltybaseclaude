-- APPLIES-TO targeting (platform/docs/plans/APPLIES-TO-TARGETING-PLAN.md §0/§3.2):
-- KPI scope by Outlet Type(s), Program, Sub-Program. EMPTY array = ALL (unscoped).
-- ADDITIVE: three defaulted array columns — every existing row gets '{}' (unscoped).
-- AlterTable
ALTER TABLE "kpi_defs" ADD COLUMN "outletTypes" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "kpi_defs" ADD COLUMN "programs" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "kpi_defs" ADD COLUMN "subPrograms" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill: a type-tagged legacy KPI carries its single type into the new array.
-- Rows with a NULL / blank "outletType" (every Deoleo row) are untouched → stay '{}' (unscoped),
-- so tenants with no scope configured remain byte-identical. "outletType" is kept (DEPRECATED).
UPDATE "kpi_defs"
SET "outletTypes" = ARRAY[btrim("outletType")]
WHERE "outletType" IS NOT NULL AND btrim("outletType") <> '';
