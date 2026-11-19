-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Wallet Reversal Engine — POST-BACKFILL migration (design §9 rollout step 6).            ⚠️ DRAFT — DO NOT APPLY YET ⚠️
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Deliberately NOT under api/prisma/migrations/ — `prisma migrate deploy` would run it on the next deploy, BEFORE the
-- backfill, and the NOT NULL / CHECK below would fail (or worse, block crediting of Bajaj's negative wallets).
--
-- APPLY ONLY WHEN ALL OF THESE HOLD, on the target DB (staging first, then prod with owner OK + backup):
--   1. WP2 applyMovement v2 is live for ALL write paths (every new wallet_transactions row gets a seq) — after this
--      migration an INSERT without seq FAILS. Includes any one-off import job that writes wallet_transactions directly.
--   2. The WP6 backfill APPLY has run for EVERY tenant with exit 0 (no BLOCKED wallets left — resolve the anomaly list).
--   3. The WP6 verify job (V0–V9) is all PASS for every tenant, run AFTER step 2 (V1 = no NULL seq, V4 = H ≥ 0).
-- HOW TO SHIP: copy this file (minus this header) to api/prisma/migrations/<YYYYMMDDHHMMSS>_wallet_reversal_post_backfill/
--   migration.sql AND change schema.prisma `WalletTransaction.seq Int?` → `seq Int` in the same commit (then
--   `prisma generate`; every walletTransaction.create must then pass seq — WP2 already does). The preflight DO-block makes
--   the migration FAIL (and roll back) instead of half-applying when a precondition is not met.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- Preflight: refuse unless the backfill is complete and the holdings invariant already holds everywhere.
DO $$
DECLARE
  null_seq   bigint;
  bad_h      bigint;
  bad_seqcnt bigint;
BEGIN
  SELECT count(*) INTO null_seq FROM "wallet_transactions" WHERE "seq" IS NULL;
  IF null_seq > 0 THEN
    RAISE EXCEPTION 'post-backfill migration refused: % wallet_transactions rows still have seq NULL (run the WP6 backfill first)', null_seq;
  END IF;

  SELECT count(*) INTO bad_h FROM "wallets" WHERE "redeemablePoints" + "debtPoints" < 0;
  IF bad_h > 0 THEN
    RAISE EXCEPTION 'post-backfill migration refused: % wallets have redeemablePoints + debtPoints < 0 (verify V4/V6)', bad_h;
  END IF;

  SELECT count(*) INTO bad_seqcnt FROM (
    SELECT w.id FROM "wallets" w LEFT JOIN "wallet_transactions" t ON t."walletId" = w.id
    GROUP BY w.id, w."movementSeq"
    HAVING coalesce(max(t."seq"), 0) <> count(t.id) OR coalesce(max(t."seq"), 0) <> w."movementSeq"
  ) x;
  IF bad_seqcnt > 0 THEN
    RAISE EXCEPTION 'post-backfill migration refused: % wallets fail seq contiguity (verify V1)', bad_seqcnt;
  END IF;
END $$;

-- I2 holdings invariant H = B + D >= 0. NOT VALID + VALIDATE: the ADD takes a brief ACCESS EXCLUSIVE lock without a
-- scan; VALIDATE scans under SHARE UPDATE EXCLUSIVE (writes keep flowing).
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_holdings_nonneg_chk" CHECK ("redeemablePoints" + "debtPoints" >= 0) NOT VALID;
ALTER TABLE "wallets" VALIDATE CONSTRAINT "wallets_holdings_nonneg_chk";

-- seq is the ordering key from now on (replaces createdAt). The existing CHECK ("seq" IS NULL OR "seq" > 0) and the
-- unique (walletId, seq) stay; SET NOT NULL scans wallet_transactions once (Bajaj prod ≈ 29k rows — sub-second).
ALTER TABLE "wallet_transactions" ALTER COLUMN "seq" SET NOT NULL;
