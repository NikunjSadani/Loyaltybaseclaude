-- Wallet Reversal Engine release (2026-11-19), step 6 of 6 — VALIDATE the NOT VALID constraints (SHARE UPDATE EXCLUSIVE only)
-- Audit B3: Prisma runs each migration FILE in one transaction, so every lock a file takes is held until that file
-- commits. The WRE schema is split so the ACCESS EXCLUSIVE locks on live tables (wallets, wallet_transactions,
-- credit_payout_entries, credit_reversals) last only for metadata-only statements; index builds (SHARE lock — blocks
-- writes, not reads) each get their own short file; FKs / CHECKs on live tables are added NOT VALID (no scan) and
-- validated in a separate file (VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE — reads + writes continue).
-- Idempotent (IF NOT EXISTS / guarded DO blocks): a re-run after a partial failure is safe. Plain session SET of
-- lock_timeout (Prisma ignores SET LOCAL): a busy table makes the file FAIL FAST (P3009 → runbook: `prisma migrate
-- resolve --rolled-back <name>` then re-deploy) instead of queueing live writers behind it.
SET lock_timeout = '5s';

ALTER TABLE "wallet_transactions" VALIDATE CONSTRAINT "wallet_transactions_reversedCreditTxId_fkey";

ALTER TABLE "wallet_transactions" VALIDATE CONSTRAINT "wallet_transactions_creditReversalId_fkey";

ALTER TABLE "wallet_transactions" VALIDATE CONSTRAINT "wallet_transactions_pointsLedgerId_fkey";

ALTER TABLE "wallet_credit_positions" VALIDATE CONSTRAINT "wallet_credit_positions_walletId_fkey";

ALTER TABLE "wallet_credit_positions" VALIDATE CONSTRAINT "wallet_credit_positions_creditTxId_fkey";

ALTER TABLE "wallet_credit_positions" VALIDATE CONSTRAINT "wallet_credit_positions_lotId_fkey";

ALTER TABLE "wallet_credit_positions" VALIDATE CONSTRAINT "wallet_credit_positions_batchId_fkey";

ALTER TABLE "credit_reversal_allocations" VALIDATE CONSTRAINT "credit_reversal_allocations_creditReversalId_fkey";

ALTER TABLE "payout_reversal_allocations" VALIDATE CONSTRAINT "payout_reversal_allocations_creditReversalId_fkey";

ALTER TABLE "payout_reversal_allocations" VALIDATE CONSTRAINT "payout_reversal_allocations_payoutEntryId_fkey";

ALTER TABLE "wallets" VALIDATE CONSTRAINT "wallets_debtPoints_nonneg_chk";

ALTER TABLE "wallets" VALIDATE CONSTRAINT "wallets_movementSeq_nonneg_chk";

ALTER TABLE "wallets" VALIDATE CONSTRAINT "wallets_backfill_blocked_reason_chk";

ALTER TABLE "wallet_transactions" VALIDATE CONSTRAINT "wallet_transactions_seq_pos_chk";

ALTER TABLE "tds_credits" VALIDATE CONSTRAINT "tds_credits_sourcePayoutEntryId_fkey";

ALTER TABLE "tds_credits" VALIDATE CONSTRAINT "tds_credits_creditReversalId_fkey";

ALTER TABLE "tds_credit_applications" VALIDATE CONSTRAINT "tds_credit_applications_payoutEntryId_fkey";
-- ─── I2 holdings CHECK — intentionally deferred to the post-backfill migration (rollout step 6) ───────────────────────
-- Today's negative wallets (8 on Bajaj prod) have B < 0 and D = 0 until the WP6 backfill sets D, so the holdings CHECK
-- "redeemablePoints" + "debtPoints" >= 0 would break crediting for those outlets. Ship it right AFTER the backfill
-- (+ verification V4), NOT VALID + VALIDATE in separate files, with wallet_transactions.seq NOT NULL.

RESET lock_timeout;
