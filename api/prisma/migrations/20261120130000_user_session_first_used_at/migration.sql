-- Auth H4 / S-H1 (owner decisions 2026-11-20): never-used-successor handback, made safe.
--   firstUsedAt        — first authenticated use of the session (JWT guard, sid tokens only) OR the first
--                        refresh presented by its holder; set once. A replayed old token is handed back its
--                        successor only while every link is still unused.
--   handedBackAt       — set atomically when a successor is handed back (at most ONE handback per successor).
--   createdFingerprint — SHA-256 of the client User-Agent (+ UA client hints) of the request that CREATED the
--                        session; a handback requires the replaying request to match it (same device).
-- Platform-wide, owner-approved. Not yet applied anywhere (edited in place before first apply).
--
-- Additive + nullable, NO defaults: each ADD COLUMN is metadata-only (no table rewrite, brief lock).
-- S-L6 backfill: sessions that exist when this migration runs must NOT qualify for a handback, so the LIVE
-- ones (the only rows that can ever be a handback target) get firstUsedAt = createdAt. Live rows only
-- (~1.2k on prod) keeps it to one small UPDATE. The backfill runs ONLY in the run that creates the column
-- (DO-block guard), so a re-run can never mark sessions created after deploy as "used".
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'user_sessions' AND column_name = 'firstUsedAt'
  ) THEN
    ALTER TABLE "user_sessions" ADD COLUMN "firstUsedAt" TIMESTAMP(3);
    UPDATE "user_sessions"
       SET "firstUsedAt" = "createdAt"
     WHERE "revokedAt" IS NULL AND "expiresAt" > now();
  END IF;
END $$;

ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "handedBackAt" TIMESTAMP(3);
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "createdFingerprint" TEXT;

RESET lock_timeout;
