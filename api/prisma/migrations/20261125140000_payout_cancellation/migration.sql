-- PAYOUT CANCELLATION (owner-approved 2026-11-25, PLATFORM-WIDE incl. Deoleo). Additive + re-runnable:
--   * CreditEntryStatus gains CANCELLED (a Gifsy admin cancelled a never-paid payout: PENDING never banked, or FAILED);
--   * AutoInvoiceStatus gains VOID and GstReimbursementStatus gains VOID (the SERVICE invoice of cancelled payouts);
--   * nullable who / when / why columns on credit_payout_entries and auto_invoices.
-- No backfill: existing rows keep NULL. The new enum labels are only referenced by runtime code (never later in this
-- migration), so ADD VALUE is safe here (PostgreSQL 12+), as in 20260621130000_credit_entry_reversed_status.
SET lock_timeout = '5s';

ALTER TYPE "CreditEntryStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "AutoInvoiceStatus" ADD VALUE IF NOT EXISTS 'VOID';
ALTER TYPE "GstReimbursementStatus" ADD VALUE IF NOT EXISTS 'VOID';

ALTER TABLE "credit_payout_entries" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
ALTER TABLE "credit_payout_entries" ADD COLUMN IF NOT EXISTS "cancelledById" TEXT;
ALTER TABLE "credit_payout_entries" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;

ALTER TABLE "auto_invoices" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);
ALTER TABLE "auto_invoices" ADD COLUMN IF NOT EXISTS "voidedById" TEXT;
ALTER TABLE "auto_invoices" ADD COLUMN IF NOT EXISTS "voidReason" TEXT;

-- One LIVE invoice per (client, outlet, month, kind): a voided invoice stays in history and must not block the NEW
-- invoice a later upload for the same outlet + month gets (owner 2026-11-25). The predicate uses "voidedAt" (set with
-- status VOID in the same write) — never the new enum label, which must not be used in the migration that adds it.
-- Every existing row has voidedAt NULL, so the partial index holds exactly the rows the old full index held.
CREATE UNIQUE INDEX IF NOT EXISTS "auto_invoices_live_outlet_period_kind_key"
  ON "auto_invoices" ("clientId", "outletCode", "period", "invoiceKind") WHERE "voidedAt" IS NULL;
DROP INDEX IF EXISTS "auto_invoices_clientId_outletCode_period_invoiceKind_key";
CREATE INDEX IF NOT EXISTS "auto_invoices_clientId_outletCode_period_invoiceKind_idx"
  ON "auto_invoices" ("clientId", "outletCode", "period", "invoiceKind");

RESET lock_timeout;
