-- Per-KPI aggregation roll-up mode for dashboard/team totals.
-- SUM (default) = cumulative sum across outlets (existing behavior).
-- OUTLET_COUNT  = count of outlets that met their own target (achieved >= target).
-- Additive + NOT NULL DEFAULT 'SUM' → every existing kpi_defs row backfills to SUM,
-- so existing tenants (incl. Deoleo) are unchanged.
ALTER TABLE "kpi_defs" ADD COLUMN "rollup" TEXT NOT NULL DEFAULT 'SUM';
