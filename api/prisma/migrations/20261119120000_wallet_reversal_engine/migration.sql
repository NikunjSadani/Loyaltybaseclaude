-- Wallet Reversal Engine release (2026-11-19): WP1 schema + policy round A (renamed from 20261117120000 to sort after prod's 20261118190000).
-- Idempotent + additive (re-runnable: IF NOT EXISTS / guarded DO blocks); a 5 s lock_timeout so a busy table makes the
-- migration FAIL FAST instead of queueing writers behind it (session-level SET — Prisma ignores SET LOCAL).
SET lock_timeout = '5s';

-- Wallet Reversal Engine — WP1 additive schema (platform/docs/plans/WALLET-REVERSAL-ENGINE-DESIGN.md §2; owner-approved
-- 2026-11-13, platform-wide). PURELY ADDITIVE: no balance, counter, lot or existing-row value changes; nothing reads or
-- writes these columns/tables until applyMovement v2 (WP2) and the backfill (WP6) ship.
--
-- Prod-safety (assumes PostgreSQL >= 11 — Cloud SQL Postgres; ADD COLUMN with a constant DEFAULT is metadata-only there,
-- no table rewrite):
--   * wallets: 2 NOT NULL DEFAULT 0 columns (metadata-only) + CHECKs. "debtPoints >= 0" / "movementSeq >= 0" are fully
--     validated (trivially true: every row reads the default 0; a short scan of a few-thousand-row table).
--     The holdings CHECK "redeemablePoints + debtPoints >= 0" is deliberately NOT created here — see the note at the
--     end of this file (it would reject legacy writes to today's negative wallets before the backfill sets D).
--   * wallet_transactions: 5 NULLable columns (metadata-only); 4 new indexes + 3 FKs built in this transaction
--     (brief write lock on wallet_transactions; table is ~tens of thousands of rows → sub-second). FK validation
--     scans are trivial (all new columns NULL).
--   * New tables are empty.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "CreditAttribution" AS ENUM ('EXACT', 'LEGACY_REPLAY', 'MANUAL', 'UNRESOLVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "PayoutAllocationState" AS ENUM ('RESERVED', 'APPLIED_CANCELLED', 'APPLIED_RECEIVABLE', 'RELEASED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum (policy round A, owner Q1 2026-11-16: per-wallet backfill outcome)
DO $$ BEGIN
  CREATE TYPE "WalletBackfillStatus" AS ENUM ('DONE', 'BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "debtPoints" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "movementSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "backfillStatus" "WalletBackfillStatus",
ADD COLUMN IF NOT EXISTS "backfillBlockedReason" TEXT,
ADD COLUMN IF NOT EXISTS "backfillCheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "wallet_transactions" ADD COLUMN IF NOT EXISTS "creditReversalId" TEXT,
ADD COLUMN IF NOT EXISTS "pointsDelta" INTEGER,
ADD COLUMN IF NOT EXISTS "pointsLedgerId" TEXT,
ADD COLUMN IF NOT EXISTS "reversedCreditTxId" TEXT,
ADD COLUMN IF NOT EXISTS "seq" INTEGER;

-- CreateTable
CREATE TABLE IF NOT EXISTS "wallet_credit_positions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "creditTxId" TEXT NOT NULL,
    "lotId" TEXT,
    "batchId" TEXT NOT NULL,
    "outletCode" TEXT,
    "fieldId" TEXT,
    "amount" INTEGER NOT NULL,
    "offsetPoints" INTEGER NOT NULL DEFAULT 0,
    "reversedPoints" INTEGER NOT NULL DEFAULT 0,
    "attribution" "CreditAttribution" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_credit_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "credit_reversal_allocations" (
    "id" TEXT NOT NULL,
    "creditReversalId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "requested" INTEGER NOT NULL,
    "debtRestored" INTEGER NOT NULL,
    "recovered" INTEGER NOT NULL,
    "owed" INTEGER NOT NULL DEFAULT 0,
    "shortfall" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_reversal_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "payout_reversal_allocations" (
    "id" TEXT NOT NULL,
    "creditReversalId" TEXT NOT NULL,
    "payoutEntryId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "state" "PayoutAllocationState" NOT NULL DEFAULT 'RESERVED',
    "tdsOffsetPaise" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_reversal_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_credit_positions_creditTxId_key" ON "wallet_credit_positions"("creditTxId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_credit_positions_lotId_key" ON "wallet_credit_positions"("lotId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_credit_positions_walletId_idx" ON "wallet_credit_positions"("walletId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_credit_positions_batchId_outletCode_fieldId_idx" ON "wallet_credit_positions"("batchId", "outletCode", "fieldId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_credit_positions_attribution_idx" ON "wallet_credit_positions"("attribution");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallets_backfillStatus_idx" ON "wallets"("backfillStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "credit_reversal_allocations_positionId_idx" ON "credit_reversal_allocations"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "credit_reversal_allocations_creditReversalId_positionId_key" ON "credit_reversal_allocations"("creditReversalId", "positionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payout_reversal_allocations_payoutEntryId_idx" ON "payout_reversal_allocations"("payoutEntryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "payout_reversal_allocations_state_idx" ON "payout_reversal_allocations"("state");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "payout_reversal_allocations_creditReversalId_payoutEntryId_key" ON "payout_reversal_allocations"("creditReversalId", "payoutEntryId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_pointsLedgerId_key" ON "wallet_transactions"("pointsLedgerId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_reversedCreditTxId_idx" ON "wallet_transactions"("reversedCreditTxId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_creditReversalId_idx" ON "wallet_transactions"("creditReversalId");

-- CreateIndex
-- (walletId, seq) unique: Postgres unique indexes are NULLS DISTINCT by default, so the many pre-backfill rows with
-- seq = NULL never collide; only assigned seqs must be unique per wallet. seq becomes NOT NULL in rollout step 6.
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_walletId_seq_key" ON "wallet_transactions"("walletId", "seq");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_reversedCreditTxId_fkey') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_reversedCreditTxId_fkey" FOREIGN KEY ("reversedCreditTxId") REFERENCES "wallet_transactions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_creditReversalId_fkey') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_creditReversalId_fkey" FOREIGN KEY ("creditReversalId") REFERENCES "credit_reversals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_pointsLedgerId_fkey') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_pointsLedgerId_fkey" FOREIGN KEY ("pointsLedgerId") REFERENCES "points_ledger"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_walletId_fkey') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_creditTxId_fkey') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_creditTxId_fkey" FOREIGN KEY ("creditTxId") REFERENCES "wallet_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_lotId_fkey') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "points_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_batchId_fkey') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "credit_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_reversal_allocations_creditReversalId_fkey') THEN
    ALTER TABLE "credit_reversal_allocations" ADD CONSTRAINT "credit_reversal_allocations_creditReversalId_fkey" FOREIGN KEY ("creditReversalId") REFERENCES "credit_reversals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_reversal_allocations_positionId_fkey') THEN
    ALTER TABLE "credit_reversal_allocations" ADD CONSTRAINT "credit_reversal_allocations_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "wallet_credit_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_reversal_allocations_creditReversalId_fkey') THEN
    ALTER TABLE "payout_reversal_allocations" ADD CONSTRAINT "payout_reversal_allocations_creditReversalId_fkey" FOREIGN KEY ("creditReversalId") REFERENCES "credit_reversals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_reversal_allocations_payoutEntryId_fkey') THEN
    ALTER TABLE "payout_reversal_allocations" ADD CONSTRAINT "payout_reversal_allocations_payoutEntryId_fkey" FOREIGN KEY ("payoutEntryId") REFERENCES "credit_payout_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Raw SQL (Prisma does not model CHECK constraints / partial indexes) ─────────────────────────────────────────────

-- Wallet invariants (§1.1). I1 D >= 0; movementSeq never negative.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_debtPoints_nonneg_chk') THEN
    ALTER TABLE "wallets" ADD CONSTRAINT "wallets_debtPoints_nonneg_chk" CHECK ("debtPoints" >= 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_movementSeq_nonneg_chk') THEN
    ALTER TABLE "wallets" ADD CONSTRAINT "wallets_movementSeq_nonneg_chk" CHECK ("movementSeq" >= 0);
  END IF;
END $$;

-- A BLOCKED wallet always says why (the reason is shown to Gifsy and in the reversal refusal).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallets_backfill_blocked_reason_chk') THEN
    ALTER TABLE "wallets" ADD CONSTRAINT "wallets_backfill_blocked_reason_chk" CHECK ("backfillStatus" IS DISTINCT FROM 'BLOCKED' OR "backfillBlockedReason" IS NOT NULL);
  END IF;
END $$;

-- Optional sanity on per-movement seq (NULL passes until the backfill).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_transactions_seq_pos_chk') THEN
    ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_seq_pos_chk" CHECK ("seq" IS NULL OR "seq" > 0);
  END IF;
END $$;

-- Position bounds (I3, I4): a_X > 0; 0 <= O_X <= a_X; 0 <= rho_X <= a_X; non-UNRESOLVED carries its (outlet, field) key.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_amount_pos_chk') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_amount_pos_chk" CHECK ("amount" > 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_offset_bounds_chk') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_offset_bounds_chk" CHECK ("offsetPoints" >= 0 AND "offsetPoints" <= "amount");
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_reversed_bounds_chk') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_reversed_bounds_chk" CHECK ("reversedPoints" >= 0 AND "reversedPoints" <= "amount");
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_credit_positions_key_chk') THEN
    ALTER TABLE "wallet_credit_positions" ADD CONSTRAINT "wallet_credit_positions_key_chk" CHECK ("attribution" = 'UNRESOLVED' OR ("outletCode" IS NOT NULL AND "fieldId" IS NOT NULL));
  END IF;
END $$;

-- POINTS allocation arithmetic (§1.2): r = p + c + owed + shortfall, all parts >= 0, r > 0. "owed" (Q4) is only ever
-- > 0 on a HISTORICAL clawback classified by the backfill that debited more than the wallet held (excess → debt).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_reversal_allocations_parts_chk') THEN
    ALTER TABLE "credit_reversal_allocations" ADD CONSTRAINT "credit_reversal_allocations_parts_chk" CHECK (
  "requested" > 0 AND "debtRestored" >= 0 AND "recovered" >= 0 AND "owed" >= 0 AND "shortfall" >= 0
  AND "debtRestored" + "recovered" + "owed" + "shortfall" = "requested"
);
  END IF;
END $$;

-- PAYOUT allocation amounts (§5).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_reversal_allocations_amounts_chk') THEN
    ALTER TABLE "payout_reversal_allocations" ADD CONSTRAINT "payout_reversal_allocations_amounts_chk" CHECK ("amountPaise" > 0 AND "tdsOffsetPaise" >= 0);
  END IF;
END $$;

-- P2/P5: a payout entry is consumed by AT MOST ONE live (RESERVED / APPLIED_*) reversal allocation; RELEASED rows
-- (rejected reversals) don't count, so the entry can be reserved again.
CREATE UNIQUE INDEX IF NOT EXISTS "payout_reversal_allocations_payoutEntryId_live_key" ON "payout_reversal_allocations"("payoutEntryId")
  WHERE "state" IN ('RESERVED', 'APPLIED_CANCELLED', 'APPLIED_RECEIVABLE');

-- ─── I2 holdings CHECK — intentionally deferred to the post-backfill migration (rollout step 6) ───────────────────────
-- A NOT VALID constraint skips EXISTING rows but is enforced on EVERY new row version. Today's negative wallets
-- (8 on Bajaj prod) have B < 0 and D = 0 until the WP6 backfill sets D, so ANY UPDATE of such a row in the window
-- between this migration and the backfill — a credit (-841 + 500 = -341), even a lastTransactionAt/updatedAt touch —
-- would fail the check and break crediting for those outlets. Ship it right AFTER the backfill (+ verification V4),
-- in the same migration that makes wallet_transactions.seq NOT NULL:
--   ALTER TABLE "wallets" ADD CONSTRAINT "wallets_holdings_nonneg_chk" CHECK ("redeemablePoints" + "debtPoints" >= 0) NOT VALID;
--   ALTER TABLE "wallets" VALIDATE CONSTRAINT "wallets_holdings_nonneg_chk";

RESET lock_timeout;
