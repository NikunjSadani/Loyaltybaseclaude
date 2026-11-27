-- TENANT REPORT RUNS (owner-approved 2026-11-27, platform-wide but INERT): one row per tenant × scheduled
-- client-facing report × IST day — first user is the Bajaj payout tracker email. The unique
-- (clientId, reportKey, runDate) row is the idempotency claim written BEFORE the send (no double-send).
-- Rows only ever exist for tenants with a `payoutTracker` program setting (Deoleo: none).
-- Additive only: one enum + one table + indexes. No FKs, no existing table touched. Re-runnable.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TenantReportRunStatus') THEN
    CREATE TYPE "TenantReportRunStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "tenant_report_runs" (
  "id"         TEXT NOT NULL,
  "clientId"   TEXT NOT NULL,
  "reportKey"  TEXT NOT NULL,
  "runDate"    TEXT NOT NULL,
  "month"      TEXT,
  "status"     "TenantReportRunStatus" NOT NULL,
  "recipients" JSONB,
  "fileName"   TEXT,
  "error"      TEXT,
  "attempts"   INTEGER NOT NULL DEFAULT 1,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_report_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_report_runs_clientId_reportKey_runDate_key"
  ON "tenant_report_runs" ("clientId", "reportKey", "runDate");
CREATE INDEX IF NOT EXISTS "tenant_report_runs_reportKey_runDate_idx"
  ON "tenant_report_runs" ("reportKey", "runDate");

RESET lock_timeout;
