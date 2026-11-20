-- Auth H4 (owner decision 2026-11-20): mark the FIRST authenticated use of a session, so a rotated
-- refresh token replayed after the grace window can be handed back its successor ONLY while that
-- successor has never been used (strict reuse-kill as soon as it has). Platform-wide, owner-approved.
-- Additive + idempotent + nullable, NO default, NO backfill: ADD COLUMN is metadata-only (no table
-- rewrite, brief ACCESS EXCLUSIVE lock only). Existing rows stay NULL = "never used" — harmless: a
-- pre-existing live session that is a successor is only ever handed back within 60 min of its creation.
SET lock_timeout = '5s';

ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "firstUsedAt" TIMESTAMP(3);

RESET lock_timeout;
