-- Support tickets: "Escalate to client admin for remarks" (platform-wide, owner-approved 2026-11-19).
-- New TicketStatus label WAITING_ON_CLIENT. Additive, no data change, no backfill.
-- Idempotent (IF NOT EXISTS). The new label is never USED in this file (Postgres forbids using a
-- label added in the same transaction), only by runtime code. ALTER TYPE takes a lock on the type
-- only, not on the tickets table; lock_timeout makes it fail fast rather than queue behind anything.
SET lock_timeout = '5s';

ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'WAITING_ON_CLIENT';

RESET lock_timeout;
