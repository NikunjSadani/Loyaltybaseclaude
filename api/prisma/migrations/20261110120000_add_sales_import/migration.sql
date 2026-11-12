-- CreateTable
CREATE TABLE "sales_import_profiles" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "columnMapping" JSONB NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_import_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_kpi_definitions" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "kpiCode" TEXT NOT NULL,
    "measure" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "outletTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "programs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_kpi_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_imports" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "fileKind" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "partCount" INTEGER NOT NULL,
    "partsReceived" INTEGER NOT NULL DEFAULT 0,
    "gcsPrefix" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADING',
    "contentSha256" TEXT,
    "duplicateOfId" TEXT,
    "mappingSnapshot" JSONB,
    "detectedHeaders" JSONB,
    "rosterHash" TEXT,
    "bytesRead" BIGINT NOT NULL DEFAULT 0,
    "rowsRead" INTEGER NOT NULL DEFAULT 0,
    "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
    "errorSamples" JSONB,
    "monthSummaries" JSONB,
    "dimensionValues" JSONB,
    "dimensionCombos" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_import_aggregates" (
    "id" BIGSERIAL NOT NULL,
    "importId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "outletCode" TEXT NOT NULL,
    "dims" JSONB NOT NULL,
    "dimKey" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "qtyMicro" BIGINT NOT NULL,
    "lines" INTEGER NOT NULL,

    CONSTRAINT "sales_import_aggregates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_import_applies" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "appliedById" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "definitionsHash" TEXT NOT NULL,
    "definitionsSnapshot" JSONB NOT NULL,
    "outletsWritten" INTEGER NOT NULL,
    "outletsZeroFilled" INTEGER NOT NULL,
    "totals" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_import_applies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_month_statuses" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenedById" TEXT,
    "lastAppliedImportId" TEXT,
    "lastAppliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_month_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_import_profiles_clientId_key" ON "sales_import_profiles"("clientId");

-- CreateIndex
CREATE INDEX "sales_kpi_definitions_clientId_idx" ON "sales_kpi_definitions"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_kpi_definitions_clientId_kpiCode_key" ON "sales_kpi_definitions"("clientId", "kpiCode");

-- CreateIndex
CREATE INDEX "sales_imports_clientId_createdAt_idx" ON "sales_imports"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "sales_imports_status_idx" ON "sales_imports"("status");

-- CreateIndex
CREATE INDEX "sales_imports_clientId_contentSha256_idx" ON "sales_imports"("clientId", "contentSha256");

-- CreateIndex
CREATE INDEX "sales_import_aggregates_importId_month_id_idx" ON "sales_import_aggregates"("importId", "month", "id");

-- CreateIndex
CREATE INDEX "sales_import_applies_clientId_month_createdAt_idx" ON "sales_import_applies"("clientId", "month", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sales_month_statuses_clientId_month_key" ON "sales_month_statuses"("clientId", "month");

-- AddForeignKey
ALTER TABLE "sales_import_aggregates" ADD CONSTRAINT "sales_import_aggregates_importId_fkey" FOREIGN KEY ("importId") REFERENCES "sales_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_import_applies" ADD CONSTRAINT "sales_import_applies_importId_fkey" FOREIGN KEY ("importId") REFERENCES "sales_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
