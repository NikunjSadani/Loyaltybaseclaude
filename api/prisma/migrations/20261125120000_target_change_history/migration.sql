-- TARGET CHANGE HISTORY (owner-approved 2026-11-25 for ALL clients incl. Deoleo): an append-only, per-outlet record of
-- every target VALUE (or per-outlet custom KPI name) a target upload actually changed — written inside the upload's
-- apply transaction, one row per (outlet, month, KPI, field) that changed (unchanged values are never logged).
-- History starts when this ships; earlier changes are not reconstructed (the screens say so).
-- Additive only: one enum + one table + indexes. No FKs (a row must outlive a deleted outlet / batch). Re-runnable.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TargetChangeType') THEN
    CREATE TYPE "TargetChangeType" AS ENUM ('CREATED', 'UPDATED', 'DELETED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "target_change_history" (
  "id"          TEXT NOT NULL,
  "clientId"    TEXT NOT NULL,
  "outletCode"  TEXT NOT NULL,
  "month"       TEXT NOT NULL,
  "kpiCode"     TEXT NOT NULL,
  "field"       TEXT NOT NULL DEFAULT 'VALUE',
  "oldValue"    JSONB,
  "newValue"    JSONB,
  "changeType"  "TargetChangeType" NOT NULL,
  "batchId"     TEXT,
  "changedById" TEXT,
  "changedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "target_change_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "target_change_history_clientId_outletCode_changedAt_idx"
  ON "target_change_history" ("clientId", "outletCode", "changedAt");
CREATE INDEX IF NOT EXISTS "target_change_history_clientId_month_idx"
  ON "target_change_history" ("clientId", "month");
CREATE INDEX IF NOT EXISTS "target_change_history_clientId_changedAt_idx"
  ON "target_change_history" ("clientId", "changedAt");
CREATE INDEX IF NOT EXISTS "target_change_history_batchId_idx"
  ON "target_change_history" ("batchId");

RESET lock_timeout;
