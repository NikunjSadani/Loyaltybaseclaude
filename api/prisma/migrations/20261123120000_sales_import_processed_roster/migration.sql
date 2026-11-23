-- Sales Import roster-only aggregates (owner decision 2026-11-23, option B). Additive only: ONE nullable column on
-- "sales_imports" (a Sales Import table; the feature is enabled for Bajaj only). No existing row is changed.
-- "processedRosterCodes" = the normalized outlet codes on the roster when the import was processed (sorted JSON array).
-- NULL = processed before this change: its aggregates cover EVERY customer code (preview / apply keep the old rules).
SET lock_timeout = '5s';

ALTER TABLE "sales_imports" ADD COLUMN IF NOT EXISTS "processedRosterCodes" JSONB;
