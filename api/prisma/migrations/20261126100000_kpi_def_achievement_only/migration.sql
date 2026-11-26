-- ACHIEVEMENT-ONLY KPIs (2026-11-26, PLATFORM-WIDE schema but opt-in): a KPI that takes no targets (e.g. Bajaj
-- BSC / FB1 / FB2 CASES, achieved only via Sales Import) is left out of the targets template, the Final Targets export
-- and the target-upload column check. Additive + idempotent: one NOT NULL column defaulting to false — every existing
-- row (every tenant incl. Deoleo) stays false = unchanged behaviour.
SET lock_timeout = '5s';

ALTER TABLE "kpi_defs" ADD COLUMN IF NOT EXISTS "achievementOnly" BOOLEAN NOT NULL DEFAULT false;

RESET lock_timeout;
