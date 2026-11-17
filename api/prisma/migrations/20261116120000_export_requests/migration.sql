-- Downloads page (platform/docs/plans/DOWNLOADS-PAGE.md): heavy report files prepared in the background by the
-- gifsy-exports Cloud Run job and listed on the Downloads page. Additive: one new table, no existing table touched.

-- CreateTable
CREATE TABLE "export_requests" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "actor" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "fileName" TEXT,
    "storagePath" TEXT,
    "sizeBytes" BIGINT,
    "rowCount" INTEGER,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "export_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "export_requests_clientId_requestedById_createdAt_idx" ON "export_requests"("clientId", "requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "export_requests_status_createdAt_idx" ON "export_requests"("status", "createdAt");
