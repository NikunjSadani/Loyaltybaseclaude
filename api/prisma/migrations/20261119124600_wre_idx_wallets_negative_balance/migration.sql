-- Wallet Reversal Engine — fix round 5 (B1, 2026-11-19): a PARTIAL index on the wallets below zero, so the
-- wallets-below-zero probe ("is any wallet of this tenant negative?") answers from a tiny index on every tenant — on
-- Deoleo (never negative) the index is EMPTY and the probe returns at once.
-- ONE live table, additive, idempotent (IF NOT EXISTS). Same rules as the other WRE index files: Prisma runs each file in
-- one transaction, so CREATE INDEX CONCURRENTLY is not possible here; a plain CREATE INDEX takes a SHARE lock (reads
-- continue, writes wait) only while it builds — wallets is small and the partial index scans it once. Plain session SET
-- of lock_timeout: a busy table makes the file FAIL FAST — run the deploy in a quiet window.
SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "wallets_negative_balance_idx" ON "wallets" ("redeemablePoints") WHERE "redeemablePoints" < 0;

RESET lock_timeout;
