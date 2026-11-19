-- Support tickets: who may read an INTERNAL note (platform-wide, owner-approved 2026-11-19).
-- Additive + idempotent: a new enum type and a NULLABLE column on ticket_messages (metadata-only
-- ADD COLUMN, no table rewrite, no backfill). NULL = legacy/generic internal note, visible to
-- every support admin exactly as before. Touches one live table (ticket_messages).
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TicketNoteVisibility') THEN
    CREATE TYPE "TicketNoteVisibility" AS ENUM ('GIFSY_ONLY', 'SHARED_WITH_CLIENT');
  END IF;
END
$$;

ALTER TABLE "ticket_messages" ADD COLUMN IF NOT EXISTS "internalVisibility" "TicketNoteVisibility";

RESET lock_timeout;
