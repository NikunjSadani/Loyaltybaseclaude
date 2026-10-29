-- Per-outlet-TYPE tag for a KPI definition (sales trade-comparison, RLP/BSC toggle).
--   NULL  = SHARED KPI, applies to every outlet type (the pre-existing behaviour).
--   'SSS' / 'WHOLESALER' / … = a type-specific KPI (Outlet.outletType.code).
-- Plain NULLABLE additive column, NO default and NO backfill: every existing kpi_defs
-- row stays NULL and behaves exactly as today, so existing tenants (incl. live Deoleo)
-- are byte-identical. The @@unique([clientId, code]) key is intentionally unchanged.
ALTER TABLE "kpi_defs" ADD COLUMN "outletType" TEXT;
