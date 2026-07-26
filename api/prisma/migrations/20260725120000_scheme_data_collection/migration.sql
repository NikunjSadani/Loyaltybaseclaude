-- Scheme data-collection (Wave-0) — remodel the "scheme" feature into an enrollment-only,
-- roster-based data-collection instrument. See platform/docs/plans/SCHEME-DATA-COLLECTION-DESIGN.md §11.
--
-- WHAT CHANGES:
--   * The enrollment SUBJECT moves from the SHOP (ChannelPartner / partnerId, added by
--     20260723140000) to a per-scheme ROSTER row (`scheme_outlets`). A roster row is a matched
--     (linked) tenant outlet OR a standalone id+name data point (D4/D9). This SUPERSEDES the
--     20260723140000 partner re-key.
--   * `scheme_enrollments` holds the CURRENT submission per roster row; `scheme_submissions` is
--     an append-only, immutable history (D10/D11). `scheme_enrollment_form_versions` snapshots the
--     form per version so old submissions render coherently. `scheme_broadcasts` logs notification
--     sends (D29). `schemes.audienceConfig` + `scheme_enrollment_forms.version` are added.
--
-- SHAPE: forward-only + DESTRUCTIVE on scheme_enrollments (drops partnerId, adds NOT NULL columns
-- with no backfill). This is SAFE ONLY because the scheme feature is dormant and prod was cleaned to
-- 0 active partners at cutover #14 — so there are NO live enrollments to migrate. The abort-guard
-- below PROVES zero rows before any destructive change; if it fires, a human must investigate rather
-- than lose data (pattern from 20260723140000).

-- ── 0. Abort-guard: assert ZERO live scheme data before the destructive remodel ────────────────
-- Fails loudly (before any schema change) if scheme_enrollments — or a pre-existing scheme_outlets —
-- holds any rows. On the expected dormant state (0 rows) this is a no-op.
DO $$
DECLARE
  enrollment_count int;
  roster_count int := 0;
BEGIN
  SELECT count(*) INTO enrollment_count FROM "scheme_enrollments";
  IF to_regclass('"scheme_outlets"') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM "scheme_outlets"' INTO roster_count;
  END IF;
  IF enrollment_count > 0 OR roster_count > 0 THEN
    RAISE EXCEPTION 'scheme data-collection remodel aborted: found % scheme_enrollment row(s) and % scheme_outlet row(s). This destructive rework (drops scheme_enrollments.partnerId, re-keys enrollment to a per-scheme roster) asserts ZERO live scheme data first. Investigate/preserve before applying — see platform/docs/plans/SCHEME-DATA-COLLECTION-DESIGN.md §11.', enrollment_count, roster_count;
  END IF;
END $$;

-- ── 1. New enum ─────────────────────────────────────────────────────────────────────────────────
-- CreateEnum
CREATE TYPE "SchemeEnrollmentStatus" AS ENUM ('SUBMITTED', 'REJECTED');

-- Scheme-enrollment consent OTP purpose (reuses the KYC consent-OTP send/verify flow, D16).
-- ADD VALUE is safe inside this transaction on PG12+ because the new value is not USED within
-- the migration itself (only at runtime). IF NOT EXISTS keeps it idempotent.
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'SCHEME_ENROLL_CONSENT';

-- ── 2. Roster / enrollment subject (created before the scheme_enrollments FK that references it) ─
-- CreateTable
CREATE TABLE "scheme_outlets" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "outletRef" TEXT NOT NULL,
    "outletName" TEXT NOT NULL,
    "matchedOutletId" TEXT,
    "matchedPartnerId" TEXT,
    "taggedSalesUserId" TEXT,
    "prefillValues" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheme_outlets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheme_outlets_schemeId_idx" ON "scheme_outlets"("schemeId");

-- CreateIndex
CREATE INDEX "scheme_outlets_matchedOutletId_idx" ON "scheme_outlets"("matchedOutletId");

-- CreateIndex
CREATE INDEX "scheme_outlets_matchedPartnerId_idx" ON "scheme_outlets"("matchedPartnerId");

-- CreateIndex
CREATE INDEX "scheme_outlets_taggedSalesUserId_idx" ON "scheme_outlets"("taggedSalesUserId");

-- CreateIndex
CREATE INDEX "scheme_outlets_clientId_idx" ON "scheme_outlets"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_outlets_schemeId_outletRef_key" ON "scheme_outlets"("schemeId", "outletRef");

-- AddForeignKey
ALTER TABLE "scheme_outlets" ADD CONSTRAINT "scheme_outlets_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_outlets" ADD CONSTRAINT "scheme_outlets_matchedOutletId_fkey" FOREIGN KEY ("matchedOutletId") REFERENCES "outlets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_outlets" ADD CONSTRAINT "scheme_outlets_matchedPartnerId_fkey" FOREIGN KEY ("matchedPartnerId") REFERENCES "channel_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_outlets" ADD CONSTRAINT "scheme_outlets_taggedSalesUserId_fkey" FOREIGN KEY ("taggedSalesUserId") REFERENCES "sales_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 3. schemes.audienceConfig + scheme_enrollment_forms.version (additive) ───────────────────────
-- AlterTable
ALTER TABLE "schemes" ADD COLUMN "audienceConfig" JSONB;

-- AlterTable
ALTER TABLE "scheme_enrollment_forms" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- ── 4. Remodel scheme_enrollments: drop the partnerId anchor, re-key to the roster ──────────────
-- 4a. Drop the (schemeId, partnerId) unique key, the partnerId FK + index, then the column.
DROP INDEX "scheme_enrollments_schemeId_partnerId_key";

ALTER TABLE "scheme_enrollments" DROP CONSTRAINT "scheme_enrollments_partnerId_fkey";

DROP INDEX "scheme_enrollments_partnerId_idx";

ALTER TABLE "scheme_enrollments" DROP COLUMN "partnerId";

-- 4b. userId → submittedByUserId (audit-only; preserve the SET NULL FK under the new name).
ALTER TABLE "scheme_enrollments" DROP CONSTRAINT "scheme_enrollments_userId_fkey";

DROP INDEX "scheme_enrollments_userId_idx";

ALTER TABLE "scheme_enrollments" RENAME COLUMN "userId" TO "submittedByUserId";

-- 4c. status String('ACTIVE') → enum SchemeEnrollmentStatus DEFAULT 'SUBMITTED'.
-- Drop the old String default first, then re-type. The USING cast body never executes (0 rows,
-- proven above), so the invalid legacy 'ACTIVE' value cannot fail the enum cast.
ALTER TABLE "scheme_enrollments" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "scheme_enrollments" ALTER COLUMN "status" TYPE "SchemeEnrollmentStatus" USING ("status"::"SchemeEnrollmentStatus");

ALTER TABLE "scheme_enrollments" ALTER COLUMN "status" SET DEFAULT 'SUBMITTED';

-- 4d. Add the roster anchor + versioning columns. NOT NULL without backfill is safe (0 rows).
ALTER TABLE "scheme_enrollments" ADD COLUMN "schemeOutletId" TEXT NOT NULL;

ALTER TABLE "scheme_enrollments" ADD COLUMN "currentVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "scheme_enrollments" ADD COLUMN "formVersion" INTEGER NOT NULL;

ALTER TABLE "scheme_enrollments" ADD COLUMN "rejectionReason" TEXT;

-- 4e. New indexes + the roster unique key. schemeOutletId is globally UNIQUE → the 1:1 enrollment
-- anchor (one current enrollment per roster row). (scheme_enrollments_schemeId_idx already exists — kept.)
CREATE UNIQUE INDEX "scheme_enrollments_schemeOutletId_key" ON "scheme_enrollments"("schemeOutletId");

CREATE INDEX "scheme_enrollments_submittedByUserId_idx" ON "scheme_enrollments"("submittedByUserId");

CREATE INDEX "scheme_enrollments_status_idx" ON "scheme_enrollments"("status");

-- 4f. FKs: roster (CASCADE — deleting the roster row deletes its enrollment); submitter (SET NULL).
ALTER TABLE "scheme_enrollments" ADD CONSTRAINT "scheme_enrollments_schemeOutletId_fkey" FOREIGN KEY ("schemeOutletId") REFERENCES "scheme_outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "scheme_enrollments" ADD CONSTRAINT "scheme_enrollments_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 5. Append-only submission history (D10/D11) ─────────────────────────────────────────────────
-- CreateTable
CREATE TABLE "scheme_submissions" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "schemeOutletId" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "SchemeEnrollmentStatus" NOT NULL,
    "formValues" JSONB NOT NULL,
    "formVersion" INTEGER NOT NULL,
    "enrollmentMode" TEXT NOT NULL,
    "submittedByUserId" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheme_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheme_submissions_schemeId_idx" ON "scheme_submissions"("schemeId");

-- CreateIndex
CREATE INDEX "scheme_submissions_schemeOutletId_idx" ON "scheme_submissions"("schemeOutletId");

-- CreateIndex
CREATE INDEX "scheme_submissions_enrollmentId_idx" ON "scheme_submissions"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_submissions_enrollmentId_version_key" ON "scheme_submissions"("enrollmentId", "version");

-- AddForeignKey
ALTER TABLE "scheme_submissions" ADD CONSTRAINT "scheme_submissions_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_submissions" ADD CONSTRAINT "scheme_submissions_schemeOutletId_fkey" FOREIGN KEY ("schemeOutletId") REFERENCES "scheme_outlets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_submissions" ADD CONSTRAINT "scheme_submissions_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "scheme_enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_submissions" ADD CONSTRAINT "scheme_submissions_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 6. Append-only form-version snapshots (D11) ─────────────────────────────────────────────────
-- CreateTable
CREATE TABLE "scheme_enrollment_form_versions" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "campaignType" TEXT NOT NULL,
    "formSchema" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheme_enrollment_form_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheme_enrollment_form_versions_schemeId_idx" ON "scheme_enrollment_form_versions"("schemeId");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_enrollment_form_versions_schemeId_version_key" ON "scheme_enrollment_form_versions"("schemeId", "version");

-- AddForeignKey
ALTER TABLE "scheme_enrollment_form_versions" ADD CONSTRAINT "scheme_enrollment_form_versions_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 7. Notification broadcast send-log (D29) ────────────────────────────────────────────────────
-- CreateTable
CREATE TABLE "scheme_broadcasts" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "recipientScope" TEXT NOT NULL,
    "recipientFilter" JSONB,
    "sentCount" INTEGER NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "sentByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheme_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheme_broadcasts_schemeId_idx" ON "scheme_broadcasts"("schemeId");

-- CreateIndex
CREATE INDEX "scheme_broadcasts_clientId_idx" ON "scheme_broadcasts"("clientId");

-- AddForeignKey
ALTER TABLE "scheme_broadcasts" ADD CONSTRAINT "scheme_broadcasts_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheme_broadcasts" ADD CONSTRAINT "scheme_broadcasts_sentByUserId_fkey" FOREIGN KEY ("sentByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
