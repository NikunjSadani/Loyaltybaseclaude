-- POINTS RULE NAME (2026-11-26, PLATFORM-WIDE schema, owner-approved): a human-readable display name for a points
-- rule so the Rules list / detail / compute preview / reports show "Unnati – ADHO 2.5%" instead of "rule_b1c5e9fc-…".
-- DISPLAY-ONLY metadata: it is never read by compute, never part of a rule's identity (ruleId/version), its hashes,
-- or any idempotency / source key. Additive + idempotent: one NULLABLE column, no default, no backfill — every
-- existing rule (every tenant incl. Deoleo) stays NULL and the UI shows "Unnamed rule" + its ruleId.
-- Length (≤120) is enforced in the API DTO, not the DB, so a later limit change needs no migration.
SET lock_timeout = '5s';

ALTER TABLE "points_rules" ADD COLUMN IF NOT EXISTS "name" TEXT;

RESET lock_timeout;
