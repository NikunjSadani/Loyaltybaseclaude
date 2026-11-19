-- Wallet Reversal Engine release (2026-11-19), step 2 of 6 — new (empty) tables with their own indexes, CHECKs and FKs between new tables
-- Audit B3: Prisma runs each migration FILE in one transaction, so every lock a file takes is held until that file
-- commits. The WRE schema is split so the ACCESS EXCLUSIVE locks on live tables (wallets, wallet_transactions,
-- credit_payout_entries, credit_reversals) last only for metadata-only statements; index builds (SHARE lock — blocks
-- writes, not reads) each get their own short file; FKs / CHECKs on live tables are added NOT VALID (no scan) and
-- validated in a separate file (VALIDATE CONSTRAINT takes only SHARE UPDATE EXCLUSIVE — reads + writes continue).
-- Idempotent (IF NOT EXISTS / guarded DO blocks): a re-run after a partial failure is safe. Plain session SET of
-- lock_timeout (Prisma ignores SET LOCAL): a busy table makes the file FAIL FAST (P3009 → runbook: `prisma migrate
-- resolve --rolled-back <name>` then re-deploy) instead of queueing live writers behind it.
SET lock_timeout = '5s';

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

ALTER TABLE "payout_reversal_allocations" ADD COLUMN IF NOT EXISTS "receivablePaise" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "tdsCreditPaise" BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "tds_credits" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "panNumber" TEXT NOT NULL,
    "section" "TdsSection" NOT NULL,
    "fyLabel" TEXT NOT NULL,
    "sourcePayoutEntryId" TEXT NOT NULL,
    "creditReversalId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "appliedPaise" BIGINT NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tds_credits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "tds_credit_applications" (
    "id" TEXT NOT NULL,
    "tdsCreditId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "payoutEntryId" TEXT NOT NULL,
    "downloadId" TEXT,
    "amountPaise" BIGINT NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_credit_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_credit_positions_creditTxId_key" ON "wallet_credit_positions"("creditTxId");

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_credit_positions_lotId_key" ON "wallet_credit_positions"("lotId");

CREATE INDEX IF NOT EXISTS "wallet_credit_positions_walletId_idx" ON "wallet_credit_positions"("walletId");

CREATE INDEX IF NOT EXISTS "wallet_credit_positions_batchId_outletCode_fieldId_idx" ON "wallet_credit_positions"("batchId", "outletCode", "fieldId");

CREATE INDEX IF NOT EXISTS "wallet_credit_positions_attribution_idx" ON "wallet_credit_positions"("attribution");

CREATE INDEX IF NOT EXISTS "credit_reversal_allocations_positionId_idx" ON "credit_reversal_allocations"("positionId");

CREATE UNIQUE INDEX IF NOT EXISTS "credit_reversal_allocations_creditReversalId_positionId_key" ON "credit_reversal_allocations"("creditReversalId", "positionId");

CREATE INDEX IF NOT EXISTS "payout_reversal_allocations_payoutEntryId_idx" ON "payout_reversal_allocations"("payoutEntryId");

CREATE INDEX IF NOT EXISTS "payout_reversal_allocations_state_idx" ON "payout_reversal_allocations"("state");

CREATE UNIQUE INDEX IF NOT EXISTS "payout_reversal_allocations_creditReversalId_payoutEntryId_key" ON "payout_reversal_allocations"("creditReversalId", "payoutEntryId");

CREATE UNIQUE INDEX IF NOT EXISTS "payout_reversal_allocations_payoutEntryId_live_key" ON "payout_reversal_allocations"("payoutEntryId")
  WHERE "state" IN ('RESERVED', 'APPLIED_CANCELLED', 'APPLIED_RECEIVABLE');

CREATE UNIQUE INDEX IF NOT EXISTS "tds_credits_sourcePayoutEntryId_key" ON "tds_credits"("sourcePayoutEntryId");

CREATE INDEX IF NOT EXISTS "tds_credits_clientId_panNumber_section_fyLabel_idx" ON "tds_credits"("clientId", "panNumber", "section", "fyLabel");

CREATE INDEX IF NOT EXISTS "tds_credits_panNumber_section_fyLabel_idx" ON "tds_credits"("panNumber", "section", "fyLabel");

CREATE INDEX IF NOT EXISTS "tds_credit_applications_tdsCreditId_idx" ON "tds_credit_applications"("tdsCreditId");

CREATE INDEX IF NOT EXISTS "tds_credit_applications_payoutEntryId_idx" ON "tds_credit_applications"("payoutEntryId");

CREATE INDEX IF NOT EXISTS "tds_credit_applications_clientId_idx" ON "tds_credit_applications"("clientId");

CREATE UNIQUE INDEX IF NOT EXISTS "tds_credit_applications_live_key" ON "tds_credit_applications"("tdsCreditId", "payoutEntryId")
  WHERE "releasedAt" IS NULL;

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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_reversal_allocations_parts_chk') THEN
    ALTER TABLE "credit_reversal_allocations" ADD CONSTRAINT "credit_reversal_allocations_parts_chk" CHECK (
  "requested" > 0 AND "debtRestored" >= 0 AND "recovered" >= 0 AND "owed" >= 0 AND "shortfall" >= 0
  AND "debtRestored" + "recovered" + "owed" + "shortfall" = "requested"
);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_reversal_allocations_amounts_chk') THEN
    ALTER TABLE "payout_reversal_allocations" ADD CONSTRAINT "payout_reversal_allocations_amounts_chk" CHECK ("amountPaise" > 0 AND "tdsOffsetPaise" >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payout_reversal_allocations_receivable_chk') THEN
    ALTER TABLE "payout_reversal_allocations" ADD CONSTRAINT "payout_reversal_allocations_receivable_chk"
  CHECK ("receivablePaise" >= 0 AND "receivablePaise" <= "amountPaise" AND "tdsCreditPaise" >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_credits_amounts_chk') THEN
    ALTER TABLE "tds_credits" ADD CONSTRAINT "tds_credits_amounts_chk"
  CHECK ("amountPaise" > 0 AND "appliedPaise" >= 0 AND "appliedPaise" <= "amountPaise");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_credit_applications_amount_chk') THEN
    ALTER TABLE "tds_credit_applications" ADD CONSTRAINT "tds_credit_applications_amount_chk" CHECK ("amountPaise" > 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_reversal_allocations_positionId_fkey') THEN
    ALTER TABLE "credit_reversal_allocations" ADD CONSTRAINT "credit_reversal_allocations_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "wallet_credit_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tds_credit_applications_tdsCreditId_fkey') THEN
    ALTER TABLE "tds_credit_applications" ADD CONSTRAINT "tds_credit_applications_tdsCreditId_fkey" FOREIGN KEY ("tdsCreditId") REFERENCES "tds_credits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

RESET lock_timeout;
