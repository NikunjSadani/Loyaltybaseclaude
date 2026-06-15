-- P2 / 2.4 follow-up (dev DB only — gifsy_dev).
-- Make the Outlet record match the actual outlet-master upload file:
--   * addressLine1 + pincode become nullable — they are NOT in the master file;
--     they are captured later at KYC (same rationale as the optional owner).
--   * beat / metro / zone / programName / programCategory — reference-only text
--     columns from the upload, for report grouping/summary (same owner decision
--     as distributorCode/Name).
-- Generated read-only via `prisma migrate diff` (live gifsy_dev -> edited schema).
-- SAFE: outlets table is empty; additive columns + relaxing NOT NULL only.

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'Refusing to run: expected database gifsy_dev, got %', current_database();
  END IF;
END $$;

ALTER TABLE "outlets"
  ADD COLUMN "beat" TEXT,
  ADD COLUMN "metro" TEXT,
  ADD COLUMN "programCategory" TEXT,
  ADD COLUMN "programName" TEXT,
  ADD COLUMN "zone" TEXT,
  ALTER COLUMN "addressLine1" DROP NOT NULL,
  ALTER COLUMN "pincode" DROP NOT NULL;

COMMIT;
