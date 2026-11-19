-- Wallet Reversal Engine release (2026-11-19), step 3 of 6 — index on wallets (SHARE lock while it builds — a few thousand rows)
-- Audit B3: Prisma runs each migration FILE in one transaction, so every lock a file takes is held until that file
-- commits. The WRE schema is split so the ACCESS EXCLUSIVE locks on live tables (wallets, wallet_transactions,
-- credit_payout_entries, credit_reversals) last only for metadata-only statements; index builds (SHARE lock — blocks
-- writes, not reads) each get their own short file; FKs / CHECKs on live tables are added NOT VALID (no scan) and
-- validated in a separate file (VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE — reads + writes continue).
-- Idempotent (IF NOT EXISTS / guarded DO blocks): a re-run after a partial failure is safe. Plain session SET of
-- lock_timeout (Prisma ignores SET LOCAL): a busy table makes the file FAIL FAST (P3009 → runbook: `prisma migrate
-- resolve --rolled-back <name>` then re-deploy) instead of queueing live writers behind it.
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "wallets_backfillStatus_idx" ON "wallets"("backfillStatus");

RESET lock_timeout;
