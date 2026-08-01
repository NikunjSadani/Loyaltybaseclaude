-- Roster-row soft-delete (SchemeOutlet.deletedAt) — additive, nullable → safe.
-- Single source of truth for a removed roster row; the composite index keeps the
-- per-scheme "removed rows" + "live rows" reads sargable at tenant scale.
ALTER TABLE "scheme_outlets" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "scheme_outlets_schemeId_deletedAt_idx" ON "scheme_outlets"("schemeId", "deletedAt");
