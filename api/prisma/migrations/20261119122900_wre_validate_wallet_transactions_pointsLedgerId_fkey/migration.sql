-- Wallet Reversal Engine release (2026-11-19) — step 30 of 44: VALIDATE wallet_transactions_pointsLedgerId_fkey
-- Re-audit B1/B6: Prisma runs each migration FILE in one transaction and keeps every lock until that file commits,
-- so each file touches at most ONE live table (an FK between two live tables necessarily locks both — noted where
-- it applies): no file can deadlock against live confirms / bank downloads / UTR uploads by taking two live-table
-- locks in a different order. ADD COLUMN (metadata-only) per table; one index per file (SHARE lock while it builds);
-- FK / CHECK on a live table added NOT VALID (no scan) one per file, then VALIDATEd one per file (SHARE UPDATE
-- EXCLUSIVE — reads and writes continue). Idempotent (IF NOT EXISTS / guarded DO / VALIDATE is a no-op when valid).
-- Plain session SET of lock_timeout (Prisma ignores SET LOCAL): a busy table makes the file FAIL FAST — run the prod
-- deploy in a quiet window (night); on P3009 follow the runbook (WALLET-REVERSAL-ENGINE-DESIGN.md §8.4).
SET lock_timeout = '5s';

ALTER TABLE "wallet_transactions" VALIDATE CONSTRAINT "wallet_transactions_pointsLedgerId_fkey";

RESET lock_timeout;
