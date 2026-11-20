/**
 * Migration 20261120140000_visibility_review_events — the backfill, run for real on PGlite (WASM Postgres).
 *
 * Proves: imported old-app captures get ONE "Imported — old app approval" event with no admin (B1); a bad
 * per-photo date never aborts the migration and falls back (S1); non-imported captures get one event per
 * submission + ONE summary event for the current outcome, no invented per-photo rows, deterministic ids (S2);
 * a second run adds nothing. Only the columns the migration reads are created here (minimal fixture schema).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startPgliteTestDb, type PgliteTestDb } from '../common/testing/pglite-testkit-spec';
import { IMPORTED_REVIEW_ACTOR_LABEL } from './visibility-review-events';

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '20261120140000_visibility_review_events', 'migration.sql'),
  'utf8',
);

const FIXTURE_SCHEMA = `
CREATE TYPE "VisibilityCaptureStatus" AS ENUM ('SUBMITTED','APPROVED','REJECTED','CHANGES_REQUESTED');
CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "sales_users" ("id" TEXT PRIMARY KEY, "userId" TEXT);
CREATE TABLE "visibility_captures" (
  "id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "outletId" TEXT NOT NULL, "windowKey" TEXT NOT NULL,
  "status" "VisibilityCaptureStatus" NOT NULL, "formValues" JSONB, "photoReviews" JSONB,
  "currentVersion" INTEGER NOT NULL DEFAULT 1, "reviewedAt" TIMESTAMP(3), "approvedByUserId" TEXT,
  "rejectionReasonCode" TEXT, "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "visibility_capture_submissions" (
  "id" TEXT PRIMARY KEY, "captureId" TEXT NOT NULL, "clientId" TEXT NOT NULL, "outletId" TEXT NOT NULL,
  "windowKey" TEXT NOT NULL, "version" INTEGER NOT NULL, "submittedBySalesUserId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL
);
INSERT INTO "users" VALUES ('admin1','Gifsy Admin'), ('rev2','Reviewer Two'), ('repU','Rep One');
INSERT INTO "sales_users" VALUES ('su1','repU');
INSERT INTO "visibility_captures" VALUES
  -- imported old-app capture: approvedBy = the importing admin, reviewedAt = the old app's approval date
  ('imp1','bajaj','o1','2025-06-P1','APPROVED',
   '{"wtk11hn":"visibility-media/bajaj/vendor-import/prod/b/OUT1/2025-06_v1.jpg"}', NULL,
   1, '2025-06-20 06:30:00', 'admin1', NULL, NULL, '2026-11-12 14:50:00', '2026-11-12 14:50:00'),
  -- imported with the {key, geo} shape and no reviewedAt → falls back to updatedAt
  ('imp2','bajaj','o2','2025-07-P1','APPROVED',
   '{"np9d0cc":{"key":"visibility-media/bajaj/vendor-import/OUT2/2025-07_v2.jpg"}}', NULL,
   1, NULL, 'admin1', NULL, NULL, '2026-11-12 14:50:00', '2026-11-12 15:00:00'),
  -- native: v1 rejected-all, then v2 approved
  ('nat1','bajaj','o3','2026-11-P1','APPROVED',
   '{"front":"visibility-media/bajaj/OUT3/front.jpg"}',
   '{"front":{"status":"APPROVED","reviewedAt":"2026-11-05T10:00:00.000Z","reviewedByUserId":"rev2"}}',
   2, '2026-11-05 10:00:00', 'rev2', NULL, NULL, '2026-11-02 09:00:00', '2026-11-05 10:00:00'),
  -- native: Needs re-take, reviewedAt missing, one photo review has a GARBAGE date, the other a valid one
  ('nat2','bajaj','o4','2026-11-P1','CHANGES_REQUESTED',
   '{"front":"visibility-media/bajaj/OUT4/front.jpg","shelf":"visibility-media/bajaj/OUT4/shelf.jpg"}',
   '{"front":{"status":"REJECTED","reasonCode":"BLURRY","reviewedAt":"2026-13-45T99:99:00Z","reviewedByUserId":"admin1"},
     "shelf":{"status":"REJECTED","reasonCode":"OTHER","reviewedAt":"2026-11-06T08:00:00.000Z","reviewedByUserId":"rev2"}}',
   1, NULL, NULL, NULL, NULL, '2026-11-03 09:00:00', '2026-11-06 08:00:01'),
  -- native: Needs re-take where EVERY photo date is garbage → falls back to updatedAt, never errors
  ('nat3','bajaj','o5','2026-11-P1','CHANGES_REQUESTED',
   '{"front":"visibility-media/bajaj/OUT5/front.jpg"}',
   '{"front":{"status":"REJECTED","reasonCode":"BLURRY","reviewedAt":"yesterday","reviewedByUserId":"admin1"}}',
   1, NULL, NULL, NULL, NULL, '2026-11-03 09:00:00', '2026-11-07 07:00:00'),
  -- native: rejected-all
  ('nat4','bajaj','o6','2026-11-P1','REJECTED',
   '{"front":"visibility-media/bajaj/OUT6/front.jpg"}', NULL,
   1, '2026-11-08 11:00:00', 'rev2', 'WRONG_OUTLET', 'different shop', '2026-11-08 09:00:00', '2026-11-08 11:00:00'),
  -- native: waiting for review → submission event only
  ('nat5','bajaj','o7','2026-11-P1','SUBMITTED',
   '{"front":"visibility-media/bajaj/OUT7/front.jpg"}', NULL,
   1, NULL, NULL, NULL, NULL, '2026-11-09 09:00:00', '2026-11-09 09:00:00');
INSERT INTO "visibility_capture_submissions" VALUES
  ('s1','nat1','bajaj','o3','2026-11-P1',1,'su1','2026-11-02 09:00:00'),
  ('s2','nat1','bajaj','o3','2026-11-P1',2,'su1','2026-11-04 09:00:00'),
  ('s3','nat2','bajaj','o4','2026-11-P1',1,'su1','2026-11-03 09:00:00'),
  ('s4','nat5','bajaj','o7','2026-11-P1',1,'su1','2026-11-09 09:00:00'),
  ('s5','imp1','bajaj','o1','2025-06-P1',1,NULL,'2026-11-12 14:50:00');
`;

type Row = {
  id: string; captureId: string; version: number; action: string; statusAfter: string | null;
  actorUserId: string | null; actorName: string | null; reasonCode: string | null; reason: string | null;
  fieldId: string | null; backfilled: boolean; createdAt: string;
};

describe('migration 20261120140000_visibility_review_events (backfill on real Postgres)', () => {
  let db: PgliteTestDb;
  let rows: Row[];
  const of = (captureId: string) => rows.filter((r) => r.captureId === captureId);

  beforeAll(async () => {
    db = startPgliteTestDb();
    await db.exec(FIXTURE_SCHEMA);
    await db.exec(MIGRATION); // must not throw despite the garbage dates
    rows = await db.query<Row>(
      `SELECT "id","captureId","version","action"::text AS "action","statusAfter"::text AS "statusAfter",
              "actorUserId","actorName","reasonCode","reason","fieldId","backfilled",
              to_char("createdAt",'YYYY-MM-DD"T"HH24:MI:SS') AS "createdAt"
         FROM "visibility_review_events" ORDER BY "id"`,
    );
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('B1: an imported capture gets exactly ONE old-app approval event — no admin name or id', () => {
    expect(of('imp1')).toEqual([
      expect.objectContaining({
        id: 'vrebf_imp1_0001_1', action: 'CAPTURE_APPROVED_ALL', statusAfter: 'APPROVED',
        actorUserId: null, actorName: IMPORTED_REVIEW_ACTOR_LABEL, backfilled: true,
        createdAt: '2025-06-20T06:30:00', // the old app's approval date, not the import date
      }),
    ]);
    // {key} shape is detected too; no reviewedAt → updatedAt.
    expect(of('imp2')).toEqual([
      expect.objectContaining({ actorName: IMPORTED_REVIEW_ACTOR_LABEL, actorUserId: null, createdAt: '2026-11-12T15:00:00' }),
    ]);
    expect(rows.some((r) => r.actorName === 'Gifsy Admin' && r.captureId.startsWith('imp'))).toBe(false);
  });

  it('S2: a native capture → one event per submission + ONE summary for the current outcome (no per-photo rows)', () => {
    expect(of('nat1').map((r) => [r.id, r.action, r.statusAfter, r.actorName, r.createdAt])).toEqual([
      ['vrebf_nat1_0001_0', 'SUBMITTED', 'SUBMITTED', 'Rep One', '2026-11-02T09:00:00'],
      ['vrebf_nat1_0002_0', 'RESUBMITTED', 'SUBMITTED', 'Rep One', '2026-11-04T09:00:00'],
      ['vrebf_nat1_0002_1', 'CAPTURE_APPROVED_ALL', 'APPROVED', 'Reviewer Two', '2026-11-05T10:00:00'],
    ]);
    expect(rows.some((r) => r.action === 'PHOTO_APPROVED' || r.action === 'PHOTO_REJECTED' || r.fieldId)).toBe(false);
    expect(of('nat4').find((r) => r.action !== 'SUBMITTED')).toMatchObject({
      action: 'CAPTURE_REJECTED_ALL', statusAfter: 'REJECTED', reasonCode: 'WRONG_OUTLET', reason: 'different shop', actorName: 'Reviewer Two',
    });
    // Waiting for review → submission only, no review event.
    expect(of('nat5').map((r) => r.action)).toEqual(['SUBMITTED']);
  });

  it('S1: a garbage per-photo date never aborts; it is skipped and the date falls back', () => {
    // nat2: the valid sent-back photo (shelf, rev2) is the latest → its time + reviewer.
    expect(of('nat2').find((r) => r.action === 'CHANGES_REQUESTED_RESULT')).toMatchObject({
      statusAfter: 'CHANGES_REQUESTED', actorUserId: 'rev2', createdAt: '2026-11-06T08:00:00',
    });
    // nat3: every photo date is garbage → updatedAt.
    expect(of('nat3')).toEqual([
      expect.objectContaining({ action: 'CHANGES_REQUESTED_RESULT', actorUserId: 'admin1', createdAt: '2026-11-07T07:00:00' }),
    ]);
  });

  it('leaves no helper function behind, and a second run adds nothing', async () => {
    const fn = await db.query(`SELECT 1 FROM pg_proc WHERE proname = '_vre_safe_ts'`);
    expect(fn).toHaveLength(0);
    await db.exec(MIGRATION);
    const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "visibility_review_events"`);
    expect(n).toBe(rows.length);
  });
});
