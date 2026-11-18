-- K1: snapshot the submitter's reporting chain at routing (consent) time, so a KYC filed by a rep who is
-- REMOVED later stays with the managers they had when it was filed (moving that manager to another branch
-- no longer moves the KYC). ADDITIVE ONLY: one column with a constant default (metadata-only on PG 11+, no
-- table rewrite). No backfill — legacy rows keep the empty array and fall back to the current link.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "kyc_submissions" ADD COLUMN "submitterManagerChain" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
