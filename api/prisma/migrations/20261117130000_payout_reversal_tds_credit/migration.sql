-- Wallet Reversal Engine — policy round B (owner 2026-11-16, WALLET-REVERSAL-ENGINE-DESIGN.md §8.1).
-- Purely additive (new columns with constant defaults + two new tables). Never applied anywhere yet.
-- Reversing an already-PAID payout entry whose TDS was DEDUCTED: receivable = net cash received; the withheld TDS
-- stays deposited and becomes a tenant-scoped credit on the PAN, applied to the next TDS deducted for that PAN.

-- AlterTable
ALTER TABLE "payout_reversal_allocations" ADD COLUMN "receivablePaise" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "tdsCreditPaise" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "tds_credits" (
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

-- CreateTable
CREATE TABLE "tds_credit_applications" (
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

-- CreateIndex
CREATE UNIQUE INDEX "tds_credits_sourcePayoutEntryId_key" ON "tds_credits"("sourcePayoutEntryId");

-- CreateIndex
CREATE INDEX "tds_credits_clientId_panNumber_section_fyLabel_idx" ON "tds_credits"("clientId", "panNumber", "section", "fyLabel");

-- CreateIndex
CREATE INDEX "tds_credits_panNumber_section_fyLabel_idx" ON "tds_credits"("panNumber", "section", "fyLabel");

-- CreateIndex
CREATE INDEX "tds_credit_applications_tdsCreditId_idx" ON "tds_credit_applications"("tdsCreditId");

-- CreateIndex
CREATE INDEX "tds_credit_applications_payoutEntryId_idx" ON "tds_credit_applications"("payoutEntryId");

-- CreateIndex
CREATE INDEX "tds_credit_applications_clientId_idx" ON "tds_credit_applications"("clientId");

-- AddForeignKey
ALTER TABLE "tds_credits" ADD CONSTRAINT "tds_credits_sourcePayoutEntryId_fkey" FOREIGN KEY ("sourcePayoutEntryId") REFERENCES "credit_payout_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_credits" ADD CONSTRAINT "tds_credits_creditReversalId_fkey" FOREIGN KEY ("creditReversalId") REFERENCES "credit_reversals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_credit_applications" ADD CONSTRAINT "tds_credit_applications_tdsCreditId_fkey" FOREIGN KEY ("tdsCreditId") REFERENCES "tds_credits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tds_credit_applications" ADD CONSTRAINT "tds_credit_applications_payoutEntryId_fkey" FOREIGN KEY ("payoutEntryId") REFERENCES "credit_payout_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Hand-written (not expressible in Prisma) ────────────────────────────────────────────────────────────────────
-- Allocation money bounds: the receivable never exceeds the entry amount; the credit is never negative. (The credit
-- may exceed amount − receivable: it also carries back earlier TDS credit that had been used for this payout.)
ALTER TABLE "payout_reversal_allocations" ADD CONSTRAINT "payout_reversal_allocations_receivable_chk"
  CHECK ("receivablePaise" >= 0 AND "receivablePaise" <= "amountPaise" AND "tdsCreditPaise" >= 0);

-- A credit is positive and can never be over-applied (defence in depth behind the PAN advisory lock + guarded UPDATE).
ALTER TABLE "tds_credits" ADD CONSTRAINT "tds_credits_amounts_chk"
  CHECK ("amountPaise" > 0 AND "appliedPaise" >= 0 AND "appliedPaise" <= "amountPaise");

ALTER TABLE "tds_credit_applications" ADD CONSTRAINT "tds_credit_applications_amount_chk" CHECK ("amountPaise" > 0);

-- A credit is applied to a given payout entry at most once at a time (a released row no longer counts → a re-bank
-- of a FAILED entry may apply it again).
CREATE UNIQUE INDEX "tds_credit_applications_live_key" ON "tds_credit_applications"("tdsCreditId", "payoutEntryId")
  WHERE "releasedAt" IS NULL;
