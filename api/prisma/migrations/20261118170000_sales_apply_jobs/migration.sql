-- Sales Import: Apply / Recalculate run as BACKGROUND JOBS in the sales-import worker (owner decision 2026-11-18).
-- ADDITIVE ONLY: two new tables + indexes. No existing table, row or index is changed. Older code ignores them.
-- Rollback (see SALES-IMPORT-PIPELINE-PLAN.md §18 item 5): mark QUEUED / RUNNING rows FAILED before deploying old code.

SET lock_timeout = '5s';

-- One row per Apply / Recalculate click.
CREATE TABLE "sales_apply_jobs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,                 -- APPLY | RECALC
    "importId" TEXT,                      -- APPLY: the import; RECALC: null
    "requestId" TEXT NOT NULL,            -- the page's per-click id (resend → same job)
    "request" JSONB NOT NULL,             -- the validated request body the worker runs
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "requestedByRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED | RUNNING | DONE | FAILED
    "claimToken" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "focusBasis" JSONB,                   -- APPLY: the stored product lists the first run resolved focus names against
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "sales_apply_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_apply_jobs_clientId_requestId_key" ON "sales_apply_jobs"("clientId", "requestId");
CREATE INDEX "sales_apply_jobs_status_createdAt_idx" ON "sales_apply_jobs"("status", "createdAt");
CREATE INDEX "sales_apply_jobs_clientId_createdAt_idx" ON "sales_apply_jobs"("clientId", "createdAt");

-- One row per month of a job: its progress and result.
CREATE TABLE "sales_apply_job_months" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED', -- QUEUED | RUNNING | DONE | FAILED
    "result" JSONB,
    "lastError" TEXT,                     -- the last retryable error (shown if the attempts run out)
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "sales_apply_job_months_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sales_apply_job_months_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "sales_apply_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sales_apply_job_months_jobId_month_key" ON "sales_apply_job_months"("jobId", "month");
CREATE INDEX "sales_apply_job_months_clientId_month_idx" ON "sales_apply_job_months"("clientId", "month");
-- At most ONE active Apply / Recalculate per tenant × month (owner: the server refuses a second apply while one runs).
-- Prisma can't express a partial index; do NOT drop it (SalesApplyJobsService maps its violation to 409).
CREATE UNIQUE INDEX "sales_apply_job_months_active_month_key" ON "sales_apply_job_months"("clientId", "month")
    WHERE "status" IN ('QUEUED', 'RUNNING');

RESET lock_timeout;
