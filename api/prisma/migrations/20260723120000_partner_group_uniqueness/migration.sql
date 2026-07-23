-- Partner → multiple outlets (parent-child owner groups) — UNIQUENESS ENGINE.
-- See platform/docs/plans/PARTNER-MULTI-OUTLET.md §"uniqueness engine".
--
-- Goal: PAN + GST are UNIQUE for UNGROUPED owners (a hard, race-proof DB rule), while grouped
-- siblings (same owner-group) MAY share them. Postgres can't express "unique-except-within-group"
-- natively (the group link lives on `outlets`, the identity fields on `channel_partners`), so:
--   * `channel_partners.groupId` — a DERIVED mirror of the owner's outlet `parentId` (single
--     source of truth). Written by KYC-create and kept in lockstep by a trigger on `outlets`.
--   * PARTIAL UNIQUE indexes on (clientId, gstNumber)/(clientId, panNumber) WHERE groupId IS NULL
--     → enforced for ungrouped owners (100% of live data today), grouped rows excepted.
--   * Cross-group uniqueness (rare, admin-driven) is app-enforced (checkGroupUniqueness) with an
--     advisory lock; bank/UPI stay tenant-configurable + app-enforced (no DB rule).
--
-- Forward-only, additive. On real prod (no KYC'd partner PAN/GST data yet) the new PAN index is a
-- no-op to build. The one demo-data fix below is scoped to a fixed seed id → no-op on prod.

-- ── 1. Derived group key ────────────────────────────────────────────────────────────────────
ALTER TABLE "channel_partners"
    ADD COLUMN "groupId" TEXT;

CREATE INDEX "channel_partners_groupId_idx" ON "channel_partners"("groupId");

-- Backfill: mirror each owner's outlet parentId onto groupId (no grouped owner exists yet, so this
-- is a no-op today, but it is correct + idempotent if run against already-grouped data).
UPDATE "channel_partners" cp
SET "groupId" = o."parentId"
FROM "outlets" o
WHERE o."partnerId" = cp."id" AND o."parentId" IS NOT NULL;

-- ── 2. Demo-data hygiene (no-op on prod) ────────────────────────────────────────────────────
-- seed-cp-4 historically shared PAN 'KLMNO9012P' with seed-cp-3 — two DISTINCT demo owners, a
-- latent seed bug that predates PAN uniqueness. Give it a distinct PAN/GST family so the new
-- partial-unique PAN index can be built on demo/staging DBs. Matches api/prisma/seed.ts. On prod
-- there is no 'seed-cp-4' row → 0 rows affected.
UPDATE "channel_partners"
SET "panNumber" = 'QRSTU3456V', "gstNumber" = '27QRSTU3456V1Z8'
WHERE "id" = 'seed-cp-4' AND "panNumber" = 'KLMNO9012P';

-- ── 3. Replace the full GST unique with a PARTIAL (ungrouped-only) unique; add PAN partial unique ─
DROP INDEX "channel_partners_clientId_gstNumber_key";

CREATE UNIQUE INDEX "channel_partners_gst_ungrouped_key"
    ON "channel_partners" ("clientId", "gstNumber")
    WHERE "groupId" IS NULL AND "gstNumber" IS NOT NULL AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX "channel_partners_pan_ungrouped_key"
    ON "channel_partners" ("clientId", "panNumber")
    WHERE "groupId" IS NULL AND "panNumber" IS NOT NULL AND "deletedAt" IS NULL;

-- ── 4. Trigger: keep channel_partners.groupId in lockstep with outlets.parentId ─────────────
-- The group link (outlets.parentId) is the SINGLE source of truth; this trigger feeds the derived
-- copy so app code never has to (drift-proof). Fires on parentId (grouping/ungrouping) or partnerId
-- (link/relink) change. KYC-create ALSO sets groupId inline at INSERT to avoid the brief NULL window
-- before the outlet is linked (so a grouped-before-KYC sibling isn't momentarily seen as ungrouped).
CREATE OR REPLACE FUNCTION sync_channel_partner_group_id() RETURNS trigger AS $$
BEGIN
    IF NEW."partnerId" IS NOT NULL THEN
        UPDATE "channel_partners" SET "groupId" = NEW."parentId" WHERE "id" = NEW."partnerId";
    END IF;
    -- On relink away from an old partner, clear that old partner's groupId.
    IF TG_OP = 'UPDATE'
       AND OLD."partnerId" IS DISTINCT FROM NEW."partnerId"
       AND OLD."partnerId" IS NOT NULL THEN
        UPDATE "channel_partners" SET "groupId" = NULL WHERE "id" = OLD."partnerId";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outlet_group_id_sync
    AFTER INSERT OR UPDATE OF "parentId", "partnerId" ON "outlets"
    FOR EACH ROW EXECUTE FUNCTION sync_channel_partner_group_id();

-- ── 5. Re-KYC PROPOSED changes (staged at draft, applied to the live partner only at APPROVAL) ─
-- An already-approved partner must never carry unverified re-KYC values, so a re-KYC stages its
-- proposed owner identity/detail patch here and it is applied at Gifsy approval, not at draft.
ALTER TABLE "kyc_submissions"
    ADD COLUMN "proposedPartner" JSONB;
