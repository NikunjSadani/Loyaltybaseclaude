-- P5 (Wallet, points & rewards) — ADDITIVE migration. Guarded to gifsy_dev.
-- Applied out-of-band via `prisma db execute` (this dev DB is db-push managed,
-- no _prisma_migrations history — never `prisma migrate dev`, it RESETS gifsy_dev).
-- Reviewed in docs/plans/reconcile/P5-wallet-points-rewards.md §3.
-- SHOW + WAIT for owner go before applying.
--
-- NOTE: `ALTER TYPE ... ADD VALUE` MUST run OUTSIDE an explicit transaction block.
-- This mirrors the proven in-repo pattern P3_doctype_split.sql (applied to gifsy_dev):
-- a standalone guard DO that RAISEs on the wrong DB (which stops execution before
-- any change), then standalone additive statements. No BEGIN/COMMIT wrapper — the
-- enum-add cannot live inside one, and the column adds are idempotent
-- (ADD COLUMN IF NOT EXISTS) so a partial re-run is clean. Verified target = PG 15.18.
--
-- Verified pre-apply (2026-06-18, read-only):
--   • current_database = gifsy_dev ; server_version = 15.18
--   • OtpPurpose members = LOGIN,REGISTRATION,PASSWORD_RESET,KYC_CONSENT,
--     WITHDRAWAL,PROFILE_UPDATE  (REDEMPTION_CONFIRM ABSENT — the orphan
--     prisma/migrations/20260606000002 was never applied to gifsy_dev; that
--     folder is NOT the source of truth here, migrations-manual/ is)
--   • reward_catalog / redemption_orders new columns ABSENT
--   • reward_catalog / redemption_orders / wallets / points_ledger = 0 rows
--     (all P5 tables empty → additive columns are zero-risk, no backfill)
--
-- Additive only — no drops, no NOT-NULL-without-default on existing tables:
--   • OtpPurpose: +REDEMPTION_CONFIRM (redeem-confirm OTP; matches spec WF4 +
--     the unported platform redeem routes)
--   • reward_catalog:  +stockQuantity (nullable = inventory untracked)
--   • redemption_orders: +voucherCode +voucherProvider (P5 voucher/gift-card
--     fulfilment lands on the order, NOT on PayoutTransaction; P6 cash-rail
--     stays strictly INR)

-- Guard: refuse anywhere but gifsy_dev. RAISE aborts the run before any change.
DO $$ BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'Refusing to run: expected gifsy_dev, got %', current_database();
  END IF;
END $$;

-- AlterEnum (outside any transaction — see NOTE above)
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'REDEMPTION_CONFIRM';

-- AlterTable (additive, idempotent)
ALTER TABLE "reward_catalog"    ADD COLUMN IF NOT EXISTS "stockQuantity"   INTEGER;
ALTER TABLE "redemption_orders" ADD COLUMN IF NOT EXISTS "voucherCode"     TEXT;
ALTER TABLE "redemption_orders" ADD COLUMN IF NOT EXISTS "voucherProvider" TEXT;
