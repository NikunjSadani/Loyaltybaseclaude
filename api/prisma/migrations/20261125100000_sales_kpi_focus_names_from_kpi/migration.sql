-- FOCUS-NAMES-FROM-KPI (owner-approved 2026-11-25, PLATFORM-WIDE but opt-in): a 'from the target file' Sales Import KPI
-- (e.g. Focus Brand CASES, QUANTITY) can read the per-outlet focus names written for ANOTHER KPI code (Focus Brand ₹),
-- so both count exactly the same products. Additive + idempotent: one NULLABLE column, no backfill. Every existing row
-- stays NULL = its own kpiCode's names (unchanged behaviour for every tenant).
SET lock_timeout = '5s';

ALTER TABLE "sales_kpi_definitions" ADD COLUMN IF NOT EXISTS "focusNamesFromKpi" TEXT;

RESET lock_timeout;
