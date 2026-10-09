-- Employee Rewards Phase B (§5.4) — catalogue CURATION flags on reward_catalog. STRICTLY ADDITIVE:
-- 4 new columns, every one with a safe default so EVERY existing row is valid on apply and the live
-- TRADE catalogue + redeem path is byte-unchanged (no backfill, no drops, no renames, no repoints).
--   * featured / dreamEligible  → curation badges, DEFAULT false
--   * visibleRoleCodes / visibleRegions → text[] visibility lists, DEFAULT '{}' (empty = visible to ALL
--     roles/regions, i.e. NO restriction; the employee redeem gate only restricts when non-empty).
-- Existing Deoleo rows read as featured=false, dreamEligible=false, visibleRoleCodes={}, visibleRegions={}.
ALTER TABLE "reward_catalog" ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "reward_catalog" ADD COLUMN "dreamEligible" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "reward_catalog" ADD COLUMN "visibleRoleCodes" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "reward_catalog" ADD COLUMN "visibleRegions" TEXT[] NOT NULL DEFAULT '{}';
