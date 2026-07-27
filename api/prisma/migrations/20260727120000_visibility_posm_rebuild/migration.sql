-- Visibility (POSM) rebuild (Wave-0) — replace the dead partner-photo scaffolding with a
-- recurring, per-window, SALES-captured, geo-fenced, Gifsy-approved capture model built on the
-- Scheme instrument. See platform/docs/plans/VISIBILITY-POSM-DESIGN.md.
--
-- SHAPE: DESTRUCTIVE on the legacy visibility photo tables (drops visibility_programs /
-- _submissions / _approvals / _fraud_log and re-columns visibility_image_hashes). SAFE ONLY
-- because the photo path is dead scaffolding, unused in every environment (visibility launches
-- OFF; the sales submit path never existed and the admin approve/reject UI was fake). The
-- abort-guard below PROVES zero legacy rows before any destructive change; if it fires, a human
-- must investigate rather than lose data (pattern from 20260725120000_scheme_data_collection).
-- The Excel AMOUNT_UPLOAD path (outlet_visibility_records + batch/audit) is UNTOUCHED (D3).

-- ── 0. Abort-guard: assert ZERO legacy visibility photo data before the destructive rebuild ──
DO $$
DECLARE
  n_prog int := 0; n_sub int := 0; n_appr int := 0; n_fraud int := 0; n_hash int := 0;
BEGIN
  IF to_regclass('"visibility_programs"')     IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM "visibility_programs"'     INTO n_prog;  END IF;
  IF to_regclass('"visibility_submissions"')  IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM "visibility_submissions"'  INTO n_sub;   END IF;
  IF to_regclass('"visibility_approvals"')    IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM "visibility_approvals"'    INTO n_appr;  END IF;
  IF to_regclass('"visibility_fraud_log"')    IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM "visibility_fraud_log"'    INTO n_fraud; END IF;
  IF to_regclass('"visibility_image_hashes"') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM "visibility_image_hashes"' INTO n_hash;  END IF;
  IF n_prog > 0 OR n_sub > 0 OR n_appr > 0 OR n_fraud > 0 OR n_hash > 0 THEN
    RAISE EXCEPTION 'visibility POSM rebuild aborted: found legacy photo rows (programs=%, submissions=%, approvals=%, fraud=%, hashes=%). This destructive rebuild asserts ZERO legacy visibility photo data first. Investigate/preserve before applying — see platform/docs/plans/VISIBILITY-POSM-DESIGN.md.', n_prog, n_sub, n_appr, n_fraud, n_hash;
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "VisibilityCaptureStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- DropForeignKey
ALTER TABLE "visibility_submissions" DROP CONSTRAINT "visibility_submissions_programId_fkey";

-- DropForeignKey
ALTER TABLE "visibility_submissions" DROP CONSTRAINT "visibility_submissions_partnerId_fkey";

-- DropForeignKey
ALTER TABLE "visibility_submissions" DROP CONSTRAINT "visibility_submissions_outletId_fkey";

-- DropForeignKey
ALTER TABLE "visibility_approvals" DROP CONSTRAINT "visibility_approvals_submissionId_fkey";

-- DropForeignKey
ALTER TABLE "visibility_fraud_log" DROP CONSTRAINT "visibility_fraud_log_submissionId_fkey";

-- DropIndex
DROP INDEX "visibility_image_hashes_submissionId_idx";

-- DropIndex
DROP INDEX "visibility_image_hashes_imageHash_idx";

-- DropIndex
DROP INDEX "visibility_image_hashes_imageHash_key";

-- AlterTable
ALTER TABLE "visibility_image_hashes" DROP COLUMN "duplicateOf",
DROP COLUMN "hashAlgorithm",
DROP COLUMN "imageHash",
DROP COLUMN "imageUrl",
DROP COLUMN "isDuplicate",
DROP COLUMN "submissionId",
ADD COLUMN     "captureId" TEXT NOT NULL,
ADD COLUMN     "clientId" TEXT NOT NULL,
ADD COLUMN     "hash" TEXT NOT NULL;

-- DropTable
DROP TABLE "visibility_programs";

-- DropTable
DROP TABLE "visibility_submissions";

-- DropTable
DROP TABLE "visibility_approvals";

-- DropTable
DROP TABLE "visibility_fraud_log";

-- DropEnum
DROP TYPE "VisibilityStatus";

-- DropEnum
DROP TYPE "VisibilityProgramStatus";

-- CreateTable
CREATE TABLE "visibility_forms" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "formSchema" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visibility_forms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visibility_form_versions" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "formSchema" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visibility_form_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visibility_captures" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "outletCode" TEXT NOT NULL,
    "outletName" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "status" "VisibilityCaptureStatus" NOT NULL DEFAULT 'SUBMITTED',
    "formValues" JSONB,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "formVersion" INTEGER NOT NULL,
    "captureLat" DECIMAL(10,8),
    "captureLng" DECIMAL(11,8),
    "captureAccuracy" DECIMAL(8,2),
    "distanceMeters" DECIMAL(10,2),
    "geoFenceOk" BOOLEAN,
    "capturedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedBySalesUserId" TEXT,
    "approvedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "rejectionReasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "visibility_captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visibility_capture_submissions" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "captureId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "VisibilityCaptureStatus" NOT NULL,
    "formValues" JSONB NOT NULL,
    "formVersion" INTEGER NOT NULL,
    "captureLat" DECIMAL(10,8),
    "captureLng" DECIMAL(11,8),
    "captureAccuracy" DECIMAL(8,2),
    "distanceMeters" DECIMAL(10,2),
    "geoFenceOk" BOOLEAN,
    "submittedBySalesUserId" TEXT,
    "rejectionReason" TEXT,
    "rejectionReasonCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visibility_capture_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "visibility_forms_clientId_key" ON "visibility_forms"("clientId");

-- CreateIndex
CREATE INDEX "visibility_form_versions_clientId_idx" ON "visibility_form_versions"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "visibility_form_versions_clientId_version_key" ON "visibility_form_versions"("clientId", "version");

-- CreateIndex
CREATE INDEX "visibility_captures_clientId_windowKey_idx" ON "visibility_captures"("clientId", "windowKey");

-- CreateIndex
CREATE INDEX "visibility_captures_clientId_status_idx" ON "visibility_captures"("clientId", "status");

-- CreateIndex
CREATE INDEX "visibility_captures_outletId_idx" ON "visibility_captures"("outletId");

-- CreateIndex
CREATE INDEX "visibility_captures_submittedBySalesUserId_idx" ON "visibility_captures"("submittedBySalesUserId");

-- CreateIndex
CREATE UNIQUE INDEX "visibility_captures_clientId_outletId_windowKey_key" ON "visibility_captures"("clientId", "outletId", "windowKey");

-- CreateIndex
CREATE INDEX "visibility_capture_submissions_clientId_windowKey_idx" ON "visibility_capture_submissions"("clientId", "windowKey");

-- CreateIndex
CREATE INDEX "visibility_capture_submissions_captureId_idx" ON "visibility_capture_submissions"("captureId");

-- CreateIndex
CREATE UNIQUE INDEX "visibility_capture_submissions_captureId_version_key" ON "visibility_capture_submissions"("captureId", "version");

-- CreateIndex
CREATE INDEX "visibility_image_hashes_clientId_hash_idx" ON "visibility_image_hashes"("clientId", "hash");

-- CreateIndex
CREATE INDEX "visibility_image_hashes_captureId_idx" ON "visibility_image_hashes"("captureId");

-- AddForeignKey
ALTER TABLE "visibility_captures" ADD CONSTRAINT "visibility_captures_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_captures" ADD CONSTRAINT "visibility_captures_submittedBySalesUserId_fkey" FOREIGN KEY ("submittedBySalesUserId") REFERENCES "sales_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_captures" ADD CONSTRAINT "visibility_captures_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_capture_submissions" ADD CONSTRAINT "visibility_capture_submissions_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "visibility_captures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_capture_submissions" ADD CONSTRAINT "visibility_capture_submissions_submittedBySalesUserId_fkey" FOREIGN KEY ("submittedBySalesUserId") REFERENCES "sales_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visibility_image_hashes" ADD CONSTRAINT "visibility_image_hashes_captureId_fkey" FOREIGN KEY ("captureId") REFERENCES "visibility_captures"("id") ON DELETE CASCADE ON UPDATE CASCADE;
