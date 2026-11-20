-- Visibility (POSM) PERMANENT review history (owner-approved 2026-11-20, platform-wide, Track 2a).
--
-- A resubmit resets the live capture's review attribution (approvedByUserId / reviewedAt / rejection*),
-- and per-version submission snapshots keep only status SUBMITTED + a copy of photoReviews — so "who
-- rejected which photo, when, and why" was lost. `visibility_review_events` is an APPEND-ONLY log the app
-- writes in the SAME transaction as every submit / resubmit / per-photo review / approve-all / reject-all.
--
-- Additive only: a new enum + a new table (no FK, so the history outlives a capture row) + 2 indexes.
-- The best-effort BACKFILL runs ONLY in the run that creates the table (DO-block guard), so a re-run can
-- never duplicate events. Backfilled rows carry backfilled = true.
--   1. every submission version -> SUBMITTED (v1) / RESUBMITTED (v>1) at the version's createdAt, actor =
--      the submitting sales rep's user + name;
--   2. every per-photo review found in any version snapshot OR the live capture's photoReviews ->
--      PHOTO_APPROVED / PHOTO_REJECTED at its reviewedAt (deduplicated: a review carried forward across
--      versions is recorded once, against the earliest version that holds it), actor = reviewer + name,
--      photo label from that form version;
--   3. each capture that is CURRENTLY whole-capture REJECTED -> CAPTURE_REJECTED_ALL (code + reason);
--   4. each capture that is APPROVED with NO per-photo reviews (pre-per-photo legacy) -> CAPTURE_APPROVED_ALL.
-- Whole-capture rejections of EARLIER versions were cleared by their resubmit and cannot be reconstructed
-- beyond their per-photo REJECTED entries (step 2).
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

    -- 1. Submissions (one per version).
    INSERT INTO "visibility_review_events"
      ("id", "clientId", "captureId", "outletId", "windowKey", "version", "action", "statusAfter",
       "actorUserId", "actorName", "backfilled", "createdAt")
    SELECT gen_random_uuid()::text, s."clientId", s."captureId", s."outletId", s."windowKey", s."version",
           (CASE WHEN s."version" <= 1 THEN 'SUBMITTED' ELSE 'RESUBMITTED' END)::"VisibilityReviewAction",
           'SUBMITTED'::"VisibilityCaptureStatus",
           su."userId", u."name", true, s."createdAt"
      FROM "visibility_capture_submissions" s
      LEFT JOIN "sales_users" su ON su."id" = s."submittedBySalesUserId"
      LEFT JOIN "users" u ON u."id" = su."userId";

    -- 2. Per-photo reviews (version snapshots + live capture), deduplicated.
    WITH pr AS (
      SELECT s."clientId", s."captureId", s."outletId", s."windowKey", s."version", s."formVersion",
             r.key AS "fieldId", r.value AS v, c."reviewedAt" AS "fallbackAt"
        FROM "visibility_capture_submissions" s
        JOIN "visibility_captures" c ON c."id" = s."captureId"
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(s."photoReviews") = 'object' THEN s."photoReviews" ELSE '{}'::jsonb END
        ) r
      UNION ALL
      SELECT c."clientId", c."id", c."outletId", c."windowKey", c."currentVersion", c."formVersion",
             r.key, r.value, c."reviewedAt"
        FROM "visibility_captures" c
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(c."photoReviews") = 'object' THEN c."photoReviews" ELSE '{}'::jsonb END
        ) r
    ),
    valid AS (
      SELECT pr.*,
             CASE WHEN (pr.v ->> 'reviewedAt') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'
                  THEN ((pr.v ->> 'reviewedAt')::timestamptz AT TIME ZONE 'UTC')
                  ELSE NULL END AS "reviewedTs"
        FROM pr
       WHERE jsonb_typeof(pr.v) = 'object' AND (pr.v ->> 'status') IN ('APPROVED', 'REJECTED')
    ),
    dedup AS (
      SELECT DISTINCT ON ("captureId", "fieldId", v ->> 'status', COALESCE(v ->> 'reviewedAt', ''))
             *
        FROM valid
       ORDER BY "captureId", "fieldId", v ->> 'status', COALESCE(v ->> 'reviewedAt', ''), "version" ASC
    )
    INSERT INTO "visibility_review_events"
      ("id", "clientId", "captureId", "outletId", "windowKey", "version", "action", "fieldId", "fieldLabel",
       "reasonCode", "reason", "actorUserId", "actorName", "backfilled", "createdAt")
    SELECT gen_random_uuid()::text, d."clientId", d."captureId", d."outletId", d."windowKey", d."version",
           (CASE WHEN d.v ->> 'status' = 'APPROVED' THEN 'PHOTO_APPROVED' ELSE 'PHOTO_REJECTED' END)::"VisibilityReviewAction",
           d."fieldId",
           (SELECT f ->> 'label'
              FROM "visibility_form_versions" fv
              CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(fv."formSchema" -> 'fields') = 'array' THEN fv."formSchema" -> 'fields' ELSE '[]'::jsonb END
              ) f
             WHERE fv."clientId" = d."clientId" AND fv."version" = d."formVersion" AND f ->> 'id' = d."fieldId"
             LIMIT 1),
           d.v ->> 'reasonCode', d.v ->> 'reason',
           d.v ->> 'reviewedByUserId', u."name", true,
           COALESCE(d."reviewedTs", d."fallbackAt", CURRENT_TIMESTAMP)
      FROM dedup d
      LEFT JOIN "users" u ON u."id" = d.v ->> 'reviewedByUserId';

    -- 3. Current whole-capture rejections.
    INSERT INTO "visibility_review_events"
      ("id", "clientId", "captureId", "outletId", "windowKey", "version", "action", "statusAfter",
       "reasonCode", "reason", "actorUserId", "actorName", "backfilled", "createdAt")
    SELECT gen_random_uuid()::text, c."clientId", c."id", c."outletId", c."windowKey", c."currentVersion",
           'CAPTURE_REJECTED_ALL'::"VisibilityReviewAction", 'REJECTED'::"VisibilityCaptureStatus",
           c."rejectionReasonCode", c."rejectionReason", c."approvedByUserId", u."name", true,
           COALESCE(c."reviewedAt", c."updatedAt")
      FROM "visibility_captures" c
      LEFT JOIN "users" u ON u."id" = c."approvedByUserId"
     WHERE c."status" = 'REJECTED';

    -- 4. Legacy approvals with no per-photo reviews.
    INSERT INTO "visibility_review_events"
      ("id", "clientId", "captureId", "outletId", "windowKey", "version", "action", "statusAfter",
       "actorUserId", "actorName", "backfilled", "createdAt")
    SELECT gen_random_uuid()::text, c."clientId", c."id", c."outletId", c."windowKey", c."currentVersion",
           'CAPTURE_APPROVED_ALL'::"VisibilityReviewAction", 'APPROVED'::"VisibilityCaptureStatus",
           c."approvedByUserId", u."name", true,
           COALESCE(c."reviewedAt", c."updatedAt")
      FROM "visibility_captures" c
      LEFT JOIN "users" u ON u."id" = c."approvedByUserId"
     WHERE c."status" = 'APPROVED'
       AND (jsonb_typeof(c."photoReviews") IS DISTINCT FROM 'object' OR c."photoReviews" = '{}'::jsonb);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "visibility_review_events_clientId_windowKey_idx"
  ON "visibility_review_events" ("clientId", "windowKey");
CREATE INDEX IF NOT EXISTS "visibility_review_events_captureId_idx"
  ON "visibility_review_events" ("captureId");

RESET lock_timeout;
