-- Employee Rewards Phase C (ADMIN-DESIGN §5.2) — the per-employee/period DISPLAY target.
-- STRICTLY ADDITIVE: a new table only; no existing table/column is touched. The target is
-- UPLOADED as data via the same employee points upload (one row per employee) and drives the
-- rep app's display-only "Potential / achievement" view (achievement = earned ÷ target). It
-- NEVER feeds the wallet/ledger/credit math — the money-audited employee credit path is
-- byte-unchanged. Unused until an employee upload carries a targetPoints value.

-- CreateTable
CREATE TABLE "employee_targets" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "targetPoints" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "employee_targets_clientId_employeeCode_period_key" ON "employee_targets"("clientId", "employeeCode", "period");

-- CreateIndex
CREATE INDEX "employee_targets_clientId_period_idx" ON "employee_targets"("clientId", "period");
