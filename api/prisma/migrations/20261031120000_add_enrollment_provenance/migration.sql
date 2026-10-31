-- Vendor data-migration provenance (additive, all columns nullable — no default/NOT NULL,
-- so every existing tenant stays byte-identical; a NULL enrollmentSource = native Gifsy enrollment).

-- CreateEnum
CREATE TYPE "EnrollmentSource" AS ENUM ('VENDOR_IMPORT');

-- AlterTable
ALTER TABLE "outlets"
  ADD COLUMN "enrollmentSource" "EnrollmentSource",
  ADD COLUMN "importBatchId" TEXT,
  ADD COLUMN "importedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "kyc_submissions"
  ADD COLUMN "enrollmentSource" "EnrollmentSource";

-- CreateIndex
CREATE INDEX "outlets_importBatchId_idx" ON "outlets"("importBatchId");
