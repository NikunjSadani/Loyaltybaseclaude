-- Support tickets: flag a client admin's REPLY to a remarks request (platform-wide, owner-approved 2026-11-19).
-- Additive + idempotent. ADD COLUMN with a constant default is metadata-only (no table rewrite) on PG 11+.
-- Existing rows get false (no existing message is a remarks reply flagged by this feature). One live table.
SET lock_timeout = '5s';

ALTER TABLE "ticket_messages" ADD COLUMN IF NOT EXISTS "isClientRemarks" BOOLEAN NOT NULL DEFAULT false;

RESET lock_timeout;
