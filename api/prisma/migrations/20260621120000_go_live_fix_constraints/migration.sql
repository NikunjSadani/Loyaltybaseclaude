-- Go-live fix wave: DB-level constraint corrections (Stream M).
--
-- Prisma cannot model PARTIAL or EXPRESSION indexes, so — like 20260621000000 — these
-- live in the migration only. Two corrections:
--   GLB-3  drop the stale COARSE TDS dedup indexes that strangle multi-row uploads.
--   GLM-4  add a one-payout-per-redemption-order unique at the DB.

-- ── GLB-3. Drop the stale coarse TDS re-upload dedup indexes ────────────────────────
-- The baseline (00000000000000) created:
--   tds_off_platform_entries_client_batch_key  UNIQUE (clientId, uploadBatchId)
--   tds_deposits_client_section_batch_key      UNIQUE (clientId, section, uploadBatchId)
-- uploadBatchId is a SINGLE deterministic file-hash shared by EVERY row of one upload,
-- so these coarse keys admit only ONE row per file — every subsequent row collides
-- (P2002) and is silently dropped, understating 194R/194C PAN/FY liability. The S4
-- fine-grained *_dedup_unique indexes (20260621000000) already provide correct
-- FILE-LEVEL dedup (full natural key + uploadBatchId), so these coarse indexes are pure
-- regression and must go. IF EXISTS keeps this idempotent across envs.
DROP INDEX IF EXISTS "tds_off_platform_entries_client_batch_key";
DROP INDEX IF EXISTS "tds_deposits_client_section_batch_key";

-- ── GLM-4. One payout per redemption order ─────────────────────────────────────────
-- A redemption settles through exactly one PayoutTransaction. Until now that invariant
-- rested only on an app-layer claim; this partial unique makes a duplicate payout row
-- for the same order impossible at the DB. NULL redemptionOrderId (credit-rail payouts)
-- is excluded by the predicate so those rows are unaffected.
CREATE UNIQUE INDEX "payout_transactions_redemption_order_unique"
  ON "payout_transactions" ("redemptionOrderId") WHERE "redemptionOrderId" IS NOT NULL;
