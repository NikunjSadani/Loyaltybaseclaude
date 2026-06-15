-- P2 / 2.4 follow-up (dev DB only — gifsy_dev).
-- Storage for the Re-KYC flag upload: a nullable JSON column on Outlet holding the
-- ReKYCFlags shape (20 booleans + remarks). Read/written atomically per outlet;
-- null = no re-KYC pending. Owner-approved 2026-06-15.
-- Generated read-only via `prisma migrate diff`. SAFE: single nullable column.

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'Refusing to run: expected database gifsy_dev, got %', current_database();
  END IF;
END $$;

ALTER TABLE "outlets" ADD COLUMN "reKycFlags" JSONB;

COMMIT;
