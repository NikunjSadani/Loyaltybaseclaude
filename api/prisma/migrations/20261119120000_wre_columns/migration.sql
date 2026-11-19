-- Wallet Reversal Engine release (2026-11-19), step 1 of 6 — enums + new columns on live tables (metadata-only; constant defaults, PG >= 11)
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
  CREATE TYPE "CreditAttribution" AS ENUM ('EXACT', 'LEGACY_REPLAY', 'MANUAL', 'UNRESOLVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PayoutAllocationState" AS ENUM ('RESERVED', 'APPLIED_CANCELLED', 'APPLIED_RECEIVABLE', 'RELEASED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WalletBackfillStatus" AS ENUM ('DONE', 'BLOCKED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "debtPoints" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "movementSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "backfillStatus" "WalletBackfillStatus",
ADD COLUMN IF NOT EXISTS "backfillBlockedReason" TEXT,
ADD COLUMN IF NOT EXISTS "backfillCheckedAt" TIMESTAMP(3);

ALTER TABLE "wallet_transactions" ADD COLUMN IF NOT EXISTS "creditReversalId" TEXT,
ADD COLUMN IF NOT EXISTS "pointsDelta" INTEGER,
ADD COLUMN IF NOT EXISTS "pointsLedgerId" TEXT,
ADD COLUMN IF NOT EXISTS "reversedCreditTxId" TEXT,
ADD COLUMN IF NOT EXISTS "seq" INTEGER;

ALTER TABLE "credit_payout_entries" ADD COLUMN IF NOT EXISTS "tdsBaseReversedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "tdsBaseReversalId" TEXT;

ALTER TABLE "credit_reversals" ADD COLUMN IF NOT EXISTS "requestRemarks" TEXT;

RESET lock_timeout;
