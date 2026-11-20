-- Visibility (POSM) PERMANENT review history (owner-approved 2026-11-20, platform-wide, Track 2a).
--
-- A resubmit resets the live capture's review attribution (approvedByUserId / reviewedAt / rejection*),
-- and per-version submission snapshots keep only status SUBMITTED + a copy of photoReviews — so "who
-- rejected which photo, when, and why" was lost. `visibility_review_events` is an APPEND-ONLY log the app
-- writes in the SAME transaction as every submit / resubmit / per-photo review / approve-all / reject-all.
--
-- Additive only: a new enum + a new table (no FK, so the history outlives a capture row) + 2 indexes.
-- The BACKFILL runs ONLY in the run that creates the table (DO-block guard), so a re-run can never
-- duplicate events. Backfilled rows carry backfilled = true (the UI says "from earlier records").
--
-- Backfill = ONLY what the old data can honestly tell (no invented per-photo decisions):
--   A. IMPORTED old-app captures (Bajaj ~51k; any photo key contains '/vendor-import/' — the same rule as
--      isImportedCapture() in api/src/visibility/visibility-review-events.ts): exactly ONE event,
--      CAPTURE_APPROVED_ALL, actor = the label 'Imported — old app approval' with NO actor id (approvedBy on
--      those rows is only the Gifsy admin who ran the import, never the reviewer), dated at the original
--      approval (reviewedAt), else updatedAt / createdAt.
--   B. every other capture:
--      1. one SUBMITTED (v1) / RESUBMITTED (v>1) event per submission row, at the row's createdAt, actor =
--         the submitting rep's user + name;
--      2. ONE summary review event per capture for its CURRENT status (nothing for SUBMITTED = not reviewed):
--         APPROVED -> CAPTURE_APPROVED_ALL · REJECTED -> CAPTURE_REJECTED_ALL (+ code/reason) ·
--         CHANGES_REQUESTED -> CHANGES_REQUESTED_RESULT; statusAfter = that status; version = currentVersion;
--         actor = approvedByUserId (APPROVED/REJECTED) or the reviewer of the latest sent-back photo
--         (CHANGES_REQUESTED); date = reviewedAt, else that photo review's time, else updatedAt / createdAt.
-- Ids are deterministic ('vrebf_<captureId>_<version 4 digits>_<0 submit | 1 review>') so same-timestamp
-- events sort the same way every time (the API also tie-breaks by version + action rank).
--
-- Date safety: every date comes from a timestamp column, except the CHANGES_REQUESTED fallback that reads a
-- per-photo reviewedAt TEXT from JSON — that goes through "_vre_safe_ts", which returns NULL (never an error)
-- for anything that is not a valid ISO timestamp, so a bad value can never abort the migration; NULL then
-- falls back to updatedAt / createdAt. The helper is dropped at the end.
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VisibilityReviewAction') THEN
    CREATE TYPE "VisibilityReviewAction" AS ENUM (
      'SUBMITTED',
      'RESUBMITTED',
      'PHOTO_APPROVED',
      'PHOTO_REJECTED',
      'CAPTURE_APPROVED_ALL',
      'CAPTURE_REJECTED_ALL',
      'CHANGES_REQUESTED_RESULT'
    );
  END IF;
END $$;

-- NULL-on-error timestamp parse (UTC). Guarded regex first (cheap), then the cast inside an EXCEPTION
-- block, so e.g. '2026-13-45T99:99' or 'yesterday' yields NULL instead of failing the whole migration.
CREATE OR REPLACE FUNCTION "_vre_safe_ts"(t text) RETURNS timestamp(3)
LANGUAGE plpgsql STABLE AS $f$
BEGIN
  IF t IS NULL OR t !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' THEN
    RETURN NULL;
  END IF;
  RETURN (t::timestamptz AT TIME ZONE 'UTC');
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$f$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'visibility_review_events'
  ) THEN
    CREATE TABLE "visibility_review_events" (
      "id"          TEXT NOT NULL,
      "clientId"    TEXT NOT NULL,
      "captureId"   TEXT NOT NULL,
      "outletId"    TEXT NOT NULL,
      "windowKey"   TEXT NOT NULL,
      "version"     INTEGER NOT NULL,
      "action"      "VisibilityReviewAction" NOT NULL,
      "statusAfter" "VisibilityCaptureStatus",
      "fieldId"     TEXT,
      "fieldLabel"  TEXT,
      "reasonCode"  TEXT,
      "reason"      TEXT,
      "actorUserId" TEXT,
      "actorName"   TEXT,
      "backfilled"  BOOLEAN NOT NULL DEFAULT false,
      "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "visibility_review_events_pkey" PRIMARY KEY ("id")
    );

    -- Which captures are imported old-app captures (any photo key under /vendor-import/).
    CREATE TEMP TABLE "_vre_imported" ON COMMIT DROP AS
      SELECT c."id"
        FROM "visibility_captures" c
       WHERE EXISTS (
         SELECT 1
           FROM jsonb_each(
             CASE WHEN jsonb_typeof(c."formValues") = 'object' THEN c."formValues" ELSE '{}'::jsonb END
           ) fv
          WHERE (CASE jsonb_typeof(fv.value)
                   WHEN 'string' THEN fv.value #>> '{}'
                   WHEN 'object' THEN fv.value ->> 'key'
                 END) LIKE '%/vendor-import/%'
       );

    -- A. Imported old-app captures: ONE event, the old app's approval (no admin name / id).
    INSERT INTO "visibility_review_events"
      ("id", "clientId", "captureId", "outletId", "windowKey", "version", "action", "statusAfter",
       "actorUserId", "actorName", "backfilled", "createdAt")
    SELECT 'vrebf_' || c."id" || '_' || lpad(c."currentVersion"::text, 4, '0') || '_1',
           c."clientId", c."id", c."outletId", c."windowKey", c."currentVersion",
           'CAPTURE_APPROVED_ALL'::"VisibilityReviewAction", c."status",
           NULL, 'Imported — old app approval', true,
           COALESCE(c."reviewedAt", c."updatedAt", c."createdAt")
      FROM "visibility_captures" c
     WHERE c."id" IN (SELECT "id" FROM "_vre_imported");

    -- B1. Submissions (one per version) of every non-imported capture.
    INSERT INTO "visibility_review_events"
      ("id", "clientId", "captureId", "outletId", "windowKey", "version", "action", "statusAfter",
       "actorUserId", "actorName", "backfilled", "createdAt")
    SELECT 'vrebf_' || s."captureId" || '_' || lpad(s."version"::text, 4, '0') || '_0',
           s."clientId", s."captureId", s."outletId", s."windowKey", s."version",
           (CASE WHEN s."version" <= 1 THEN 'SUBMITTED' ELSE 'RESUBMITTED' END)::"VisibilityReviewAction",
           'SUBMITTED'::"VisibilityCaptureStatus",
           su."userId", u."name", true, s."createdAt"
      FROM "visibility_capture_submissions" s
      LEFT JOIN "sales_users" su ON su."id" = s."submittedBySalesUserId"
      LEFT JOIN "users" u ON u."id" = su."userId"
     WHERE s."captureId" NOT IN (SELECT "id" FROM "_vre_imported")
    ON CONFLICT ("id") DO NOTHING;

    -- B2. ONE summary review event per reviewed, non-imported capture (its CURRENT outcome only).
    WITH last_sent_back AS (
      -- The most recent sent-back photo review on the live row (CHANGES_REQUESTED actor + date fallback).
      SELECT DISTINCT ON (c."id")
             c."id" AS "captureId",
             r.value ->> 'reviewedByUserId' AS "reviewerId",
             "_vre_safe_ts"(r.value ->> 'reviewedAt') AS "reviewedTs"
        FROM "visibility_captures" c
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(c."photoReviews") = 'object' THEN c."photoReviews" ELSE '{}'::jsonb END
        ) r
       WHERE c."status" = 'CHANGES_REQUESTED'
         AND jsonb_typeof(r.value) = 'object'
         AND r.value ->> 'status' = 'REJECTED'
       ORDER BY c."id", "_vre_safe_ts"(r.value ->> 'reviewedAt') DESC NULLS LAST, r.key
    )
    INSERT INTO "visibility_review_events"
      ("id", "clientId", "captureId", "outletId", "windowKey", "version", "action", "statusAfter",
       "reasonCode", "reason", "actorUserId", "actorName", "backfilled", "createdAt")
    SELECT 'vrebf_' || c."id" || '_' || lpad(c."currentVersion"::text, 4, '0') || '_1',
           c."clientId", c."id", c."outletId", c."windowKey", c."currentVersion",
           (CASE c."status"
              WHEN 'APPROVED' THEN 'CAPTURE_APPROVED_ALL'
              WHEN 'REJECTED' THEN 'CAPTURE_REJECTED_ALL'
              ELSE 'CHANGES_REQUESTED_RESULT'
            END)::"VisibilityReviewAction",
           c."status",
           CASE WHEN c."status" = 'REJECTED' THEN c."rejectionReasonCode" END,
           CASE WHEN c."status" = 'REJECTED' THEN c."rejectionReason" END,
           a."actorId", u."name", true,
           COALESCE(c."reviewedAt", lsb."reviewedTs", c."updatedAt", c."createdAt")
      FROM "visibility_captures" c
      LEFT JOIN last_sent_back lsb ON lsb."captureId" = c."id"
      CROSS JOIN LATERAL (
        SELECT CASE WHEN c."status" = 'CHANGES_REQUESTED'
                    THEN COALESCE(lsb."reviewerId", c."approvedByUserId")
                    ELSE c."approvedByUserId" END AS "actorId"
      ) a
      LEFT JOIN "users" u ON u."id" = a."actorId"
     WHERE c."status" IN ('APPROVED', 'REJECTED', 'CHANGES_REQUESTED')
       AND c."id" NOT IN (SELECT "id" FROM "_vre_imported")
    ON CONFLICT ("id") DO NOTHING;

    DROP TABLE IF EXISTS "_vre_imported";
  END IF;
END $$;

DROP FUNCTION IF EXISTS "_vre_safe_ts"(text);

CREATE INDEX IF NOT EXISTS "visibility_review_events_clientId_windowKey_idx"
  ON "visibility_review_events" ("clientId", "windowKey");
CREATE INDEX IF NOT EXISTS "visibility_review_events_captureId_idx"
  ON "visibility_review_events" ("captureId");

RESET lock_timeout;
