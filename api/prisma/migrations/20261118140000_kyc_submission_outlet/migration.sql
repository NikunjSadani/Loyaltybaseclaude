-- KYC permission gap G2: record the OUTLET a KYC submission was filed for, so the consent / OTP gate checks the
-- assignment on THAT outlet (not on any outlet of a multi-outlet partner). ADDITIVE ONLY: one nullable column + index
-- + FK (ON DELETE SET NULL). No backfill — legacy rows stay NULL and keep the partner-level check.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "kyc_submissions" ADD COLUMN "outletId" TEXT;

-- CreateIndex
CREATE INDEX "kyc_submissions_outletId_idx" ON "kyc_submissions"("outletId");

-- AddForeignKey
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
