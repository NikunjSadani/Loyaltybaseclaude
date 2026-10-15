-- SO Declaration KYC variant (additive; STANDARD keeps every tenant byte-identical).
-- See platform/docs/plans/SO-DECLARATION-KYC.md.

-- 1. New enum for the KYC variant.
CREATE TYPE "KycVariant" AS ENUM ('STANDARD', 'SO_DECLARATION');

-- 2. New KycDocumentType value for the dual-signed declaration PDF.
--    (Only ADDED here, not used in this migration — safe on PostgreSQL 12+.)
ALTER TYPE "KycDocumentType" ADD VALUE IF NOT EXISTS 'SO_DECLARATION';

-- 3. New columns on kyc_submissions (all nullable / defaulted → no backfill, Deoleo untouched).
ALTER TABLE "kyc_submissions"
  ADD COLUMN "kycVariant" "KycVariant" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "declarationData" JSONB,
  ADD COLUMN "soSignatureKey" TEXT,
  ADD COLUMN "asmSignatureKey" TEXT,
  ADD COLUMN "declarationPdfKey" TEXT;
