-- P3 — split the KycDocumentType.OTHER overload into distinct enum values so the
-- review dump / detail page can identify the store board photo vs the self-
-- declaration by type (was a filename heuristic). Additive, guarded to gifsy_dev.
-- Applied out-of-band via `prisma db execute` (db-push managed dev DB).
-- NOTE: ALTER TYPE ... ADD VALUE must run outside an explicit transaction block.

DO $$ BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'Refusing to run: expected gifsy_dev, got %', current_database();
  END IF;
END $$;

ALTER TYPE "KycDocumentType" ADD VALUE IF NOT EXISTS 'STORE_BOARD_PHOTO';
ALTER TYPE "KycDocumentType" ADD VALUE IF NOT EXISTS 'SELF_DECLARATION';
