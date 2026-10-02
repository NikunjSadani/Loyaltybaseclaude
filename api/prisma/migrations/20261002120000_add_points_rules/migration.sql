-- Points Compute Engine (Wave 0) — the versioned rule store (ADDITIVE, dormant).
-- New table only; no existing table/column touched. The engine is off by default
-- (per-tenant pointsEngine.enabled flag in program_settings, default false), so this
-- table is unused until a tenant is opted in. Immutable versions: a published row is
-- never mutated; "editing" creates the next version. Denormalized kpiCode/program/
-- programCategory mirror attachsTo for indexed attachment lookup.

-- CreateTable
CREATE TABLE "points_rules" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "evaluationBasis" TEXT NOT NULL DEFAULT 'PERIOD_AGGREGATE',
    "attachsTo" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "rounding" JSONB NOT NULL,
    "inputs" JSONB NOT NULL,
    "pipeline" JSONB NOT NULL,
    "kpiCode" TEXT NOT NULL,
    "program" TEXT,
    "programCategory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "points_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "points_rules_clientId_ruleId_version_key" ON "points_rules"("clientId", "ruleId", "version");

-- CreateIndex
CREATE INDEX "points_rules_clientId_idx" ON "points_rules"("clientId");

-- CreateIndex
CREATE INDEX "points_rules_clientId_status_idx" ON "points_rules"("clientId", "status");

-- CreateIndex
CREATE INDEX "points_rules_clientId_program_kpiCode_status_idx" ON "points_rules"("clientId", "program", "kpiCode", "status");
