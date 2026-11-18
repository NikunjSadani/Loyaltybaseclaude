-- Usage Report (owner-approved 2026-11-18, platform-wide): per-day visits, duration and medium on
-- the existing user_activity_day row (one row per user per IST day). See
-- platform/docs/plans/USAGE-REPORT.md.
--
--   visits         +1 on the first tracked write of the day, or after a >= 30-minute gap (new visit).
--                  0 = a legacy day recorded before this shipped (no duration / medium known).
--   activeSeconds  += the gap since lastSeenAt when < 30 minutes (same visit) — a MINIMUM.
--   appUsed / browserUsed    the platform's X-Client-Medium header (installed app vs browser tab).
--   phoneUsed / computerUsed derived from the User-Agent.
--
-- ADDITIVE ONLY: six NOT NULL columns with constant defaults (a metadata-only change on PG 11+ — no
-- table rewrite, no backfill). Idempotent (IF NOT EXISTS). lock_timeout bounds the brief ACCESS
-- EXCLUSIVE lock the ALTER needs so a busy table fails fast instead of queueing every request
-- behind it (plain SET, not SET LOCAL — Prisma does not wrap the file in a transaction).
SET lock_timeout = '5s';

ALTER TABLE "user_activity_day"
  ADD COLUMN IF NOT EXISTS "activeSeconds" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "appUsed"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "browserUsed"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "computerUsed"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "phoneUsed"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "visits"        INTEGER NOT NULL DEFAULT 0;

RESET lock_timeout;
