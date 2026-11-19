-- Wallet Reversal Engine — owner decision 2026-11-19: a V2 POINTS over-reversal becomes wallet DEBT (repaid from future
-- earnings) instead of a written-off shortfall. The part taken beyond what the wallet held is recorded in the existing
-- credit_reversal_allocations."owed" column; this flag tells it apart from a HISTORICAL clawback the backfill classified
-- as owed (Q4 — listed on the attention banner). Every existing row gets false, which is correct: no engine row had
-- owed > 0 before this rule.
-- ONE live table; ADD COLUMN with a constant default is metadata-only (no rewrite, no scan). Idempotent. Plain session
-- SET of lock_timeout (Prisma ignores SET LOCAL): a busy table makes the file FAIL FAST — run it in a quiet window.
SET lock_timeout = '5s';

ALTER TABLE "credit_reversal_allocations" ADD COLUMN IF NOT EXISTS "overReversalDebt" BOOLEAN NOT NULL DEFAULT false;

RESET lock_timeout;
