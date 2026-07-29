-- Visibility-led payouts: 194C auto-invoicing + tenant-configurable TDS — Wave 0 foundation.
-- See platform/docs/plans/VISIBILITY-PAYOUT-TDS-WAVE0-SCHEMA.md + VISIBILITY-PAYOUT-TDS-INVOICING-DESIGN.md.
--
-- SHAPE: ADDITIVE. New enums + columns (with defaults + a payoutStream backfill) + ledger/holdback
-- tables + an auto_invoices unique-key swap (kind-aware). No rows dropped; existing invoices default
-- invoiceKind=SERVICE so the new unique holds identically. Zero-downtime; no abort-guard required.

-- CreateEnum
CREATE TYPE "PayoutStream" AS ENUM ('VISIBILITY', 'INCENTIVE');

-- CreateEnum
CREATE TYPE "TdsMethodology" AS ENUM ('DEDUCT', 'GROSS_UP');

-- CreateEnum
CREATE TYPE "AutoInvoiceKind" AS ENUM ('SERVICE', 'TDS');

-- CreateEnum
CREATE TYPE "GstReimbursementStatus" AS ENUM ('HELD', 'RELEASED');

-- AlterTable: CreditField — add the payout-stream classifier, backfill from the deprecated boolean
ALTER TABLE "credit_fields" ADD COLUMN "payoutStream" "PayoutStream" NOT NULL DEFAULT 'INCENTIVE';
UPDATE "credit_fields" SET "payoutStream" = 'VISIBILITY' WHERE "isSeparatePayout" = true;

-- AlterTable: CreditPayoutEntry — invoice link + FROZEN TDS treatment + DEDUCT net
ALTER TABLE "credit_payout_entries"
    ADD COLUMN "autoInvoiceId" TEXT,
    ADD COLUMN "tdsSection" "TdsSection",
    ADD COLUMN "tdsMethodology" "TdsMethodology",
    ADD COLUMN "tdsDeductedPaise" BIGINT NOT NULL DEFAULT 0;

-- AlterTable: AutoInvoice — kind, UTR-lock, TDS-invoice PAN/FY link
ALTER TABLE "auto_invoices"
    ADD COLUMN "invoiceKind" "AutoInvoiceKind" NOT NULL DEFAULT 'SERVICE',
    ADD COLUMN "lockedAt" TIMESTAMP(3),
    ADD COLUMN "linkedPanNumber" TEXT,
    ADD COLUMN "linkedFyLabel" TEXT;

-- DropIndex + CreateIndex: swap the idempotency unique to be kind-aware (SERVICE rows unaffected)
DROP INDEX "auto_invoices_clientId_outletCode_period_key";
CREATE UNIQUE INDEX "auto_invoices_clientId_outletCode_period_invoiceKind_key" ON "auto_invoices"("clientId", "outletCode", "period", "invoiceKind");

-- CreateIndex: one gross-up TDS invoice per (clientId, PAN, FY) — PARTIAL unique (migration-only; Prisma can't model)
CREATE UNIQUE INDEX "auto_invoices_tds_pan_fy_key" ON "auto_invoices"("clientId", "linkedPanNumber", "linkedFyLabel") WHERE "invoiceKind" = 'TDS';

-- CreateIndex: AutoInvoice.linkedPanNumber lookup
CREATE INDEX "auto_invoices_linkedPanNumber_idx" ON "auto_invoices"("linkedPanNumber");

-- CreateTable: tds_deduction_entries (DEDUCT carry-forward, append-only)
CREATE TABLE "tds_deduction_entries" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "panNumber" TEXT NOT NULL,
    "section" "TdsSection" NOT NULL,
    "fyLabel" TEXT NOT NULL,
    "creditPayoutEntryId" TEXT,
    "outletCode" TEXT,
    "eventBasePaise" BIGINT NOT NULL,
    "cumulativeBasePaise" BIGINT NOT NULL,
    "tdsRate" DECIMAL(5,2) NOT NULL,
    "tdsDueCumulativePaise" BIGINT NOT NULL,
    "tdsDeductedPriorPaise" BIGINT NOT NULL,
    "tdsDeductedThisPaise" BIGINT NOT NULL,
    "carryForwardPaise" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_deduction_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tds_deduction_entries_panNumber_section_fyLabel_idx" ON "tds_deduction_entries"("panNumber", "section", "fyLabel");

-- CreateIndex
CREATE INDEX "tds_deduction_entries_clientId_idx" ON "tds_deduction_entries"("clientId");

-- CreateIndex
CREATE INDEX "tds_deduction_entries_creditPayoutEntryId_idx" ON "tds_deduction_entries"("creditPayoutEntryId");

-- CreateTable: tds_recovery_entries (GROSS-UP pro-rata recovery, append-only, dashboard-only)
CREATE TABLE "tds_recovery_entries" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "panNumber" TEXT NOT NULL,
    "section" "TdsSection" NOT NULL,
    "fyLabel" TEXT NOT NULL,
    "tdsInvoiceId" TEXT,
    "panTdsTotalPaise" BIGINT NOT NULL,
    "tenantBasePaise" BIGINT NOT NULL,
    "panBasePaise" BIGINT NOT NULL,
    "tenantSharePaise" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tds_recovery_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tds_recovery_entries_clientId_fyLabel_idx" ON "tds_recovery_entries"("clientId", "fyLabel");

-- CreateIndex
CREATE INDEX "tds_recovery_entries_panNumber_section_fyLabel_idx" ON "tds_recovery_entries"("panNumber", "section", "fyLabel");

-- CreateIndex
CREATE INDEX "tds_recovery_entries_tdsInvoiceId_idx" ON "tds_recovery_entries"("tdsInvoiceId");

-- CreateTable: gst_reimbursements (GST holdback/release; Gifsy-only screen)
CREATE TABLE "gst_reimbursements" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "autoInvoiceId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "outletCode" TEXT NOT NULL,
    "gstPaise" BIGINT NOT NULL,
    "status" "GstReimbursementStatus" NOT NULL DEFAULT 'HELD',
    "proofUrl" TEXT,
    "releasePayoutRef" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gst_reimbursements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gst_reimbursements_autoInvoiceId_key" ON "gst_reimbursements"("autoInvoiceId");

-- CreateIndex
CREATE INDEX "gst_reimbursements_clientId_idx" ON "gst_reimbursements"("clientId");

-- CreateIndex
CREATE INDEX "gst_reimbursements_status_idx" ON "gst_reimbursements"("status");

-- CreateIndex: CreditPayoutEntry.autoInvoiceId
CREATE INDEX "credit_payout_entries_autoInvoiceId_idx" ON "credit_payout_entries"("autoInvoiceId");

-- AddForeignKey
ALTER TABLE "credit_payout_entries" ADD CONSTRAINT "credit_payout_entries_autoInvoiceId_fkey" FOREIGN KEY ("autoInvoiceId") REFERENCES "auto_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gst_reimbursements" ADD CONSTRAINT "gst_reimbursements_autoInvoiceId_fkey" FOREIGN KEY ("autoInvoiceId") REFERENCES "auto_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
