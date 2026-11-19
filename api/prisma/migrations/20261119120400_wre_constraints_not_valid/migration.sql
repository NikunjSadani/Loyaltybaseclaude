-- Wallet Reversal Engine release (2026-11-19), step 5 of 6 — FKs / CHECKs touching live tables, added NOT VALID (no scan)
-- Audit B3: Prisma runs each migration FILE in one transaction, so every lock a file takes is held until that file
-- commits. The WRE schema is split so the ACCESS EXCLUSIVE locks on live tables (wallets, wallet_transactions,
-- credit_payout_entries, credit_reversals) last only for metadata-only statements; index builds (SHARE lock — blocks
-- writes, not reads) each get their own short file; FKs / CHECKs on live tables are added NOT VALID (no scan) and
-- validated in a separate file (VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE — reads + writes continue).
-- Idempotent (IF NOT EXISTS / guarded DO blocks): a re-run after a partial failure is safe. Plain session SET of
-- lock_timeout (Prisma ignores SET LOCAL): a busy table makes the file FAIL FAST (P3009 → runbook: `prisma migrate
-- resolve --rolled-back <name>` then re-deploy) instead of queueing live writers behind it.
SET lock_timeout = '5s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_reversedCreditTxId_fkey') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_reversedCreditTxId_fkey" FOREIGN KEY ("reversedCreditTxId") REFERENCES "wallet_transactions"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_creditReversalId_fkey') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_creditReversalId_fkey" FOREIGN KEY ("creditReversalId") REFERENCES "credit_reversals"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_pointsLedgerId_fkey') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_pointsLedgerId_fkey" FOREIGN KEY ("pointsLedgerId") REFERENCES "points_ledger"("id") ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_walletId_fkey') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_creditTxId_fkey') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_creditTxId_fkey" FOREIGN KEY ("creditTxId") REFERENCES "wallet_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_lotId_fkey') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "points_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_batchId_fkey') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "credit_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_reversal_allocations_creditReversalId_fkey') THEN
    ALTER TABLE "credit_reversal_allocations" ADD CONSTRAINT "credit_reversal_allocations_creditReversalId_fkey" FOREIGN KEY ("creditReversalId") REFERENCES "credit_reversals"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_reversal_allocations_creditReversalId_fkey') THEN
    ALTER TABLE "payout_reversal_allocations" ADD CONSTRAINT "payout_reversal_allocations_creditReversalId_fkey" FOREIGN KEY ("creditReversalId") REFERENCES "credit_reversals"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_reversal_allocations_payoutEntryId_fkey') THEN
    ALTER TABLE "payout_reversal_allocations" ADD CONSTRAINT "payout_reversal_allocations_payoutEntryId_fkey" FOREIGN KEY ("payoutEntryId") REFERENCES "credit_payout_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_debtPoints_nonneg_chk') THEN
    ALTER TABLE "wallets" ADD CONSTRAINT "wallets_debtPoints_nonneg_chk" CHECK ("debtPoints" >= 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_movementSeq_nonneg_chk') THEN
    ALTER TABLE "wallets" ADD CONSTRAINT "wallets_movementSeq_nonneg_chk" CHECK ("movementSeq" >= 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_backfill_blocked_reason_chk') THEN
    ALTER TABLE "wallets" ADD CONSTRAINT "wallets_backfill_blocked_reason_chk" CHECK ("backfillStatus" IS DISTINCT FROM 'BLOCKED' OR "backfillBlockedReason" IS NOT NULL) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_seq_pos_chk') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_seq_pos_chk" CHECK ("seq" IS NULL OR "seq" > 0) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_credits_sourcePayoutEntryId_fkey') THEN
    ALTER TABLE "tds_credits" ADD CONSTRAINT "tds_credits_sourcePayoutEntryId_fkey" FOREIGN KEY ("sourcePayoutEntryId") REFERENCES "credit_payout_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_credits_creditReversalId_fkey') THEN
    ALTER TABLE "tds_credits" ADD CONSTRAINT "tds_credits_creditReversalId_fkey" FOREIGN KEY ("creditReversalId") REFERENCES "credit_reversals"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_credit_applications_payoutEntryId_fkey') THEN
    ALTER TABLE "tds_credit_applications" ADD CONSTRAINT "tds_credit_applications_payoutEntryId_fkey" FOREIGN KEY ("payoutEntryId") REFERENCES "credit_payout_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

RESET lock_timeout;
