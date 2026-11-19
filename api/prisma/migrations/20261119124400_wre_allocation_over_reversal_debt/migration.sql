-- Wallet Reversal Engine — owner decisions 2026-11-19 (V2 engine):
--  (1) a POINTS over-reversal becomes wallet DEBT (repaid from future earnings) instead of a written-off shortfall. The
--      part taken beyond what the wallet held is recorded in the existing credit_reversal_allocations."owed" column;
--      "overReversalDebt" tells it apart from a HISTORICAL clawback the backfill classified as owed (Q4 — listed on the
--      attention banner). Every existing row gets false, which is correct: no engine row had owed > 0 before this rule.
--  (2) expired points are not recovered twice: the reversed credit's own points that already EXPIRED count as already
--      recovered — nothing is taken and no debt is booked for them. "alreadyExpired" records that part, so the parts
--      CHECK becomes p + c + owed + shortfall + alreadyExpired = requested (every existing row has alreadyExpired 0, so
--      it satisfies the new CHECK exactly as it satisfied the old one).
-- ONE live table. ADD COLUMN with a constant default is metadata-only (no rewrite, no scan). The new CHECK is added
-- NOT VALID here (no scan) and VALIDATEd in the next file (SHARE UPDATE EXCLUSIVE — reads and writes continue).
-- Idempotent. Plain session SET of lock_timeout (Prisma ignores SET LOCAL): a busy table makes the file FAIL FAST.
SET lock_timeout = '5s';

ALTER TABLE "credit_reversal_allocations" ADD COLUMN IF NOT EXISTS "overReversalDebt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "credit_reversal_allocations" ADD COLUMN IF NOT EXISTS "alreadyExpired" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "credit_reversal_allocations" DROP CONSTRAINT IF EXISTS "credit_reversal_allocations_parts_chk";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_reversal_allocations_parts_v2_chk') THEN
    ALTER TABLE "credit_reversal_allocations" ADD CONSTRAINT "credit_reversal_allocations_parts_v2_chk" CHECK (
  "requested" > 0 AND "debtRestored" >= 0 AND "recovered" >= 0 AND "owed" >= 0 AND "shortfall" >= 0 AND "alreadyExpired" >= 0
  AND "debtRestored" + "recovered" + "owed" + "shortfall" + "alreadyExpired" = "requested"
) NOT VALID;
  END IF;
END $$;

RESET lock_timeout;
