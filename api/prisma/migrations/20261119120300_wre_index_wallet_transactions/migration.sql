-- Wallet Reversal Engine release (2026-11-19), step 4 of 6 — indexes on wallet_transactions (SHARE lock while they build)
-- Audit B3: Prisma runs each migration FILE in one transaction, so every lock a file takes is held until that file
-- commits. The WRE schema is split so the ACCESS EXCLUSIVE locks on live tables (wallets, wallet_transactions,
-- credit_payout_entries, credit_reversals) last only for metadata-only statements; index builds (SHARE lock — blocks
-- writes, not reads) each get their own short file; FKs / CHECKs on live tables are added NOT VALID (no scan) and
-- validated in a separate file (VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE — reads + writes continue).
-- Idempotent (IF NOT EXISTS / guarded DO blocks): a re-run after a partial failure is safe. Plain session SET of
-- lock_timeout (Prisma ignores SET LOCAL): a busy table makes the file FAIL FAST (P3009 → runbook: `prisma migrate
-- resolve --rolled-back <name>` then re-deploy) instead of queueing live writers behind it.
SET lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_pointsLedgerId_key" ON "wallet_transactions"("pointsLedgerId");

CREATE INDEX IF NOT EXISTS "wallet_transactions_reversedCreditTxId_idx" ON "wallet_transactions"("reversedCreditTxId");

CREATE INDEX IF NOT EXISTS "wallet_transactions_creditReversalId_idx" ON "wallet_transactions"("creditReversalId");

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_walletId_seq_key" ON "wallet_transactions"("walletId", "seq");

RESET lock_timeout;
