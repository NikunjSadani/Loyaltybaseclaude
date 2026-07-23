-- SchemeEnrollment: re-key from the LOGIN (userId) to the SHOP (ChannelPartner / partnerId).
-- See platform/docs/plans/PARTNER-MULTI-OUTLET.md (Wave 3 login picker).
--
-- WHY: a login-less same-group sibling (a child outlet that shares the owner's phone and has
-- NO login of its own) must be able to self-enroll in a scheme via the login picker. Enrollment
-- was keyed by `userId` (a required User FK), which a login-less sibling lacks. Making the SHOP
-- the enrollment subject removes that limitation.
--
-- SHAPE: additive-ish + forward-only + safe on live data.
--   * `partnerId` is added, backfilled from each enrollment's login's ChannelPartner, then made
--     NOT NULL.
--   * `userId` becomes NULLABLE (kept for audit — which login performed the enrollment; null for a
--     login-less sibling) and its FK relaxes from CASCADE to SET NULL.
--   * The unique key moves from (schemeId, userId) to (schemeId, partnerId).
--   * ORPHAN enrollments — an enrollment whose userId maps to NO ChannelPartner — would fail the
--     NOT NULL in step 4. Rather than SILENTLY DELETE a possibly-legitimate row (a partner could
--     have been hard-deleted while its User survived — audit MED-1), step 3 ABORTS the migration
--     loudly if any orphan remains after backfill, BEFORE any irreversible schema change. On clean
--     data (every enrollment came from a live partner login) it is a no-op. If it fires, resolve the
--     orphans first (the same pre-check is in PARTNER-MULTI-OUTLET.md §9's CUTOVER CHECKLIST).

-- ── 1. Add the new subject column (nullable first, so the backfill can populate it) ──────────
ALTER TABLE "scheme_enrollments" ADD COLUMN "partnerId" TEXT;

-- ── 2. Backfill: the shop = the enrolled login's ChannelPartner (userId → channel_partners.id) ─
UPDATE "scheme_enrollments" e
SET "partnerId" = cp."id"
FROM "channel_partners" cp
WHERE cp."userId" = e."userId";

-- ── 3. Safety guard: ABORT (do NOT silently delete) if any enrollment failed to backfill ───────
-- An enrollment whose userId maps to no ChannelPartner cannot be attributed to a shop. Fail loudly
-- BEFORE the irreversible schema changes below so a human investigates, rather than destroying a
-- possibly-legitimate row. No-op on clean data (real enrollments always came from a partner login).
DO $$
DECLARE orphan_count int;
BEGIN
  SELECT count(*) INTO orphan_count FROM "scheme_enrollments" WHERE "partnerId" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'scheme_enrollment re-key aborted: % enrollment(s) have a userId with no ChannelPartner and cannot be attributed to a shop. Resolve these orphans before migrating (see PARTNER-MULTI-OUTLET.md §9 CUTOVER CHECKLIST).', orphan_count;
  END IF;
END $$;

-- ── 4. Now every surviving row has a shop → enforce NOT NULL ─────────────────────────────────
ALTER TABLE "scheme_enrollments" ALTER COLUMN "partnerId" SET NOT NULL;

-- ── 5. userId is now audit-only + optional (login-less siblings have none) ───────────────────
ALTER TABLE "scheme_enrollments" ALTER COLUMN "userId" DROP NOT NULL;

-- ── 6. Swap the unique key (schemeId,userId) → (schemeId,partnerId); add the partnerId index ──
DROP INDEX "scheme_enrollments_schemeId_userId_key";

CREATE UNIQUE INDEX "scheme_enrollments_schemeId_partnerId_key" ON "scheme_enrollments"("schemeId", "partnerId");

CREATE INDEX "scheme_enrollments_partnerId_idx" ON "scheme_enrollments"("partnerId");

-- ── 7. FK to channel_partners (CASCADE — deleting the shop deletes its enrollments) ──────────
ALTER TABLE "scheme_enrollments" ADD CONSTRAINT "scheme_enrollments_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 8. Relax the userId FK CASCADE → SET NULL (the login is now optional audit metadata) ─────
ALTER TABLE "scheme_enrollments" DROP CONSTRAINT "scheme_enrollments_userId_fkey";

ALTER TABLE "scheme_enrollments" ADD CONSTRAINT "scheme_enrollments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
