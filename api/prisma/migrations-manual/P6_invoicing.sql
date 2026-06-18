-- ============================================================================
-- P6.7 — Invoicing: AutoInvoice status/lock/snapshot + per-outlet-per-month uniqueness
-- ============================================================================
-- Self-bill visibility invoicing, persisted for real (was 100% mock). Generation is
-- AUTOMATIC (per outlet, per month on visibility settlement) → the unique index on
-- (clientId, outletCode, period) prevents a retry/concurrent settlement double-issuing.
-- Independently audited. Guarded gifsy_dev, idempotent, additive; auto_invoices is EMPTY.
-- Money cols (subtotal/gst/total Paise) are already BigInt (P6.0). GST base = pre-GST.
-- ============================================================================
DO $$
BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'Refusing to run: current_database() = % (expected gifsy_dev)', current_database();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AutoInvoiceStatus') THEN
    CREATE TYPE "AutoInvoiceStatus" AS ENUM ('GENERATED', 'PAID');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                 AND table_name='auto_invoices' AND column_name='status') THEN
    ALTER TABLE "auto_invoices" ADD COLUMN "status" "AutoInvoiceStatus" NOT NULL DEFAULT 'GENERATED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                 AND table_name='auto_invoices' AND column_name='invoiceNumberEdited') THEN
    ALTER TABLE "auto_invoices" ADD COLUMN "invoiceNumberEdited" BOOLEAN NOT NULL DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                 AND table_name='auto_invoices' AND column_name='outletCode') THEN
    ALTER TABLE "auto_invoices" ADD COLUMN "outletCode" TEXT NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                 AND table_name='auto_invoices' AND column_name='period') THEN
    ALTER TABLE "auto_invoices" ADD COLUMN "period" TEXT NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                 AND table_name='auto_invoices' AND column_name='gstType') THEN
    ALTER TABLE "auto_invoices" ADD COLUMN "gstType" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                 AND table_name='auto_invoices' AND column_name='snapshot') THEN
    ALTER TABLE "auto_invoices" ADD COLUMN "snapshot" JSONB NOT NULL DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                 AND indexname='auto_invoices_clientId_outletCode_period_key') THEN
    CREATE UNIQUE INDEX "auto_invoices_clientId_outletCode_period_key"
      ON "auto_invoices" ("clientId", "outletCode", "period");
  END IF;
END $$;
