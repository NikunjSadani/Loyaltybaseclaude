-- ============================================================================
-- P6.0 — Money-unit standardisation (gap #19)
-- ============================================================================
-- Standardise ALL money on integer minor units (paise), stored as BigInt (int8).
--   (1) Awards/Credits rail: Decimal(15,2) rupees  -> BIGINT paise (×100) + rename *Inr/*Amount -> *Paise
--       CreditBatch.totalPoints (Decimal)          -> INTEGER whole points (round, NO ×100)
--   (2) Existing paise rail: widen Int (int4, max ₹21.47M) -> BIGINT to remove the
--       aggregate-overflow risk on totals/balances (Payouts/Fund/Invoice).
--
-- Why BigInt: int4 max = 2,147,483,647 paise ≈ ₹21.47M — a single award batch total /
-- fund balance for a large FMCG tenant overflows it. int8 paise is the industry standard.
-- Why now: all finance tables are EMPTY in gifsy_dev (verified 0 rows) -> the cheapest
-- possible moment; no back-fill, no downtime.
--
-- Independently audited (read-only) before apply. Guarded to gifsy_dev. Idempotent
-- (each block checks the column's pre-state). No ALTER TYPE ADD VALUE -> safe in one txn.
-- ============================================================================
DO $$
BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'Refusing to run: current_database() = % (expected gifsy_dev)', current_database();
  END IF;

  -- ── (1) AWARDS / CREDITS rail: Decimal rupees -> BIGINT paise (×100) + rename ──────────

  -- credit_batches.totalPayoutInr (Decimal rupees, default 0) -> totalPayoutPaise (BIGINT)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='credit_batches' AND column_name='totalPayoutInr') THEN
    ALTER TABLE "credit_batches" ALTER COLUMN "totalPayoutInr" DROP DEFAULT;
    ALTER TABLE "credit_batches" ALTER COLUMN "totalPayoutInr" TYPE BIGINT USING (round("totalPayoutInr" * 100))::bigint;
    ALTER TABLE "credit_batches" ALTER COLUMN "totalPayoutInr" SET DEFAULT 0;
    ALTER TABLE "credit_batches" RENAME COLUMN "totalPayoutInr" TO "totalPayoutPaise";
  END IF;

  -- credit_batches.totalPoints (Decimal, default 0) -> INTEGER whole points (NO ×100)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='credit_batches'
               AND column_name='totalPoints' AND data_type IN ('numeric','decimal')) THEN
    ALTER TABLE "credit_batches" ALTER COLUMN "totalPoints" DROP DEFAULT;
    ALTER TABLE "credit_batches" ALTER COLUMN "totalPoints" TYPE INTEGER USING (round("totalPoints"))::integer;
    ALTER TABLE "credit_batches" ALTER COLUMN "totalPoints" SET DEFAULT 0;
  END IF;

  -- credit_payout_entries.amountInr (Decimal, no default) -> amountPaise (BIGINT)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='credit_payout_entries' AND column_name='amountInr') THEN
    ALTER TABLE "credit_payout_entries" ALTER COLUMN "amountInr" TYPE BIGINT USING (round("amountInr" * 100))::bigint;
    ALTER TABLE "credit_payout_entries" RENAME COLUMN "amountInr" TO "amountPaise";
  END IF;

  -- credit_payout_downloads.totalAmountInr (Decimal, no default) -> totalAmountPaise (BIGINT)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='credit_payout_downloads' AND column_name='totalAmountInr') THEN
    ALTER TABLE "credit_payout_downloads" ALTER COLUMN "totalAmountInr" TYPE BIGINT USING (round("totalAmountInr" * 100))::bigint;
    ALTER TABLE "credit_payout_downloads" RENAME COLUMN "totalAmountInr" TO "totalAmountPaise";
  END IF;

  -- credit_reversals.originalAmount/requestedAmount (Decimal, no default) + approvedAmount (nullable) -> *Paise (BIGINT)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='credit_reversals' AND column_name='originalAmount') THEN
    ALTER TABLE "credit_reversals" ALTER COLUMN "originalAmount" TYPE BIGINT USING (round("originalAmount" * 100))::bigint;
    ALTER TABLE "credit_reversals" RENAME COLUMN "originalAmount" TO "originalPaise";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='credit_reversals' AND column_name='requestedAmount') THEN
    ALTER TABLE "credit_reversals" ALTER COLUMN "requestedAmount" TYPE BIGINT USING (round("requestedAmount" * 100))::bigint;
    ALTER TABLE "credit_reversals" RENAME COLUMN "requestedAmount" TO "requestedPaise";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='credit_reversals' AND column_name='approvedAmount') THEN
    ALTER TABLE "credit_reversals" ALTER COLUMN "approvedAmount" TYPE BIGINT USING (round("approvedAmount" * 100))::bigint;
    ALTER TABLE "credit_reversals" RENAME COLUMN "approvedAmount" TO "approvedPaise";
  END IF;

  -- ── (2) EXISTING paise rail: widen Int -> BIGINT (no value change; ×1) ─────────────────
  -- payout_batches.totalAmountPaise
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='payout_batches' AND column_name='totalAmountPaise' AND data_type='integer') THEN
    ALTER TABLE "payout_batches" ALTER COLUMN "totalAmountPaise" TYPE BIGINT;
  END IF;
  -- payout_transactions.amountPaise / netAmountPaise / tdsPaise
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='payout_transactions' AND column_name='amountPaise' AND data_type='integer') THEN
    ALTER TABLE "payout_transactions" ALTER COLUMN "amountPaise" TYPE BIGINT;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='payout_transactions' AND column_name='netAmountPaise' AND data_type='integer') THEN
    ALTER TABLE "payout_transactions" ALTER COLUMN "netAmountPaise" TYPE BIGINT;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='payout_transactions' AND column_name='tdsPaise' AND data_type='integer') THEN
    ALTER TABLE "payout_transactions" ALTER COLUMN "tdsPaise" TYPE BIGINT;
  END IF;
  -- fund_ledger.amountPaise / balancePaise
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='fund_ledger' AND column_name='amountPaise' AND data_type='integer') THEN
    ALTER TABLE "fund_ledger" ALTER COLUMN "amountPaise" TYPE BIGINT;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='fund_ledger' AND column_name='balancePaise' AND data_type='integer') THEN
    ALTER TABLE "fund_ledger" ALTER COLUMN "balancePaise" TYPE BIGINT;
  END IF;
  -- fund_receipts.amountPaise
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='fund_receipts' AND column_name='amountPaise' AND data_type='integer') THEN
    ALTER TABLE "fund_receipts" ALTER COLUMN "amountPaise" TYPE BIGINT;
  END IF;
  -- tds_records.tdsPaise
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='tds_records' AND column_name='tdsPaise' AND data_type='integer') THEN
    ALTER TABLE "tds_records" ALTER COLUMN "tdsPaise" TYPE BIGINT;
  END IF;
  -- auto_invoices.subtotalPaise / gstPaise / totalPaise
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='auto_invoices' AND column_name='subtotalPaise' AND data_type='integer') THEN
    ALTER TABLE "auto_invoices" ALTER COLUMN "subtotalPaise" TYPE BIGINT;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='auto_invoices' AND column_name='gstPaise' AND data_type='integer') THEN
    ALTER TABLE "auto_invoices" ALTER COLUMN "gstPaise" TYPE BIGINT;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
             AND table_name='auto_invoices' AND column_name='totalPaise' AND data_type='integer') THEN
    ALTER TABLE "auto_invoices" ALTER COLUMN "totalPaise" TYPE BIGINT;
  END IF;
END $$;
