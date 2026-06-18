-- ============================================================================
-- P6.5 — TDS engine foundation (gap #25)  [independently audited]
-- ============================================================================
-- COMPUTE + TRACK + EXPORT layer over existing data (credit payouts, redemptions,
-- visibility) keyed by PAN per financial year, plus two new UPLOAD tables:
--   1) tds_off_platform_entries — 194R gifts/payouts given OUTSIDE the platform.
--   2) tds_deposits — TDS deposited to the government (reconciliation): 194R by the
--      CLIENT (per-tenant, clientId set), 194C by GIFSY (platform, clientId null).
-- Also: redemption INR-value base + per-section tagging seams (see notes).
-- Guarded gifsy_dev, idempotent, additive. Money = BigInt paise.
-- ============================================================================
DO $$
BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'Refusing to run: current_database() = % (expected gifsy_dev)', current_database();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TdsSection') THEN
    CREATE TYPE "TdsSection" AS ENUM ('SEC_194R', 'SEC_194C');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TdsDepositorType') THEN
    CREATE TYPE "TdsDepositorType" AS ENUM ('CLIENT', 'GIFSY');
  END IF;

  -- ── Off-platform 194R entries (additive uploads; uploadBatchId for re-upload dedup) ──
  CREATE TABLE IF NOT EXISTS "tds_off_platform_entries" (
    "id"            TEXT          NOT NULL PRIMARY KEY,
    "clientId"      TEXT          NOT NULL,
    "section"       "TdsSection"  NOT NULL DEFAULT 'SEC_194R',
    "entryDate"     TIMESTAMP(3)  NOT NULL,
    "panNumber"     TEXT          NOT NULL,
    "outletCode"    TEXT,
    "amountPaise"   BIGINT        NOT NULL,
    "uploadBatchId" TEXT,
    "uploadedBy"    TEXT,
    "createdAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS "tds_off_platform_entries_client_pan_idx"  ON "tds_off_platform_entries" ("clientId", "panNumber");
  CREATE INDEX IF NOT EXISTS "tds_off_platform_entries_client_date_idx" ON "tds_off_platform_entries" ("clientId", "entryDate");
  -- Re-upload dedup: a batch id is unique per tenant (partial — only when supplied).
  CREATE UNIQUE INDEX IF NOT EXISTS "tds_off_platform_entries_client_batch_key"
    ON "tds_off_platform_entries" ("clientId", "uploadBatchId") WHERE "uploadBatchId" IS NOT NULL;

  -- ── TDS deposits (194R = client per-tenant; 194C = Gifsy platform) ────────
  CREATE TABLE IF NOT EXISTS "tds_deposits" (
    "id"            TEXT                NOT NULL PRIMARY KEY,
    "section"       "TdsSection"        NOT NULL,
    "depositorType" "TdsDepositorType"  NOT NULL,
    "clientId"      TEXT,
    "depositDate"   TIMESTAMP(3)        NOT NULL,
    "panNumber"     TEXT                NOT NULL,
    "outletCode"    TEXT,
    "amountPaise"   BIGINT              NOT NULL,
    "uploadBatchId" TEXT,
    "uploadedBy"    TEXT,
    "createdAt"     TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS "tds_deposits_section_pan_idx"        ON "tds_deposits" ("section", "panNumber");
  CREATE INDEX IF NOT EXISTS "tds_deposits_client_section_pan_idx" ON "tds_deposits" ("clientId", "section", "panNumber");
  CREATE INDEX IF NOT EXISTS "tds_deposits_depositDate_idx"        ON "tds_deposits" ("depositDate");
  CREATE UNIQUE INDEX IF NOT EXISTS "tds_deposits_client_section_batch_key"
    ON "tds_deposits" ("clientId", "section", "uploadBatchId") WHERE "uploadBatchId" IS NOT NULL;

  -- ── Section tag on per-transaction TDS records (was implicitly 194R) ──────
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                 AND table_name='tds_records' AND column_name='section') THEN
    ALTER TABLE "tds_records" ADD COLUMN "section" "TdsSection";
  END IF;

  -- ── Redemption INR-value base for 194R (snapshotted at fulfilment) ────────
  -- RedemptionOrder stores points only; 194R needs the INR value of the benefit.
  -- Value = pointsDeducted ÷ conversionRate (the points↔₹ converter), FROZEN on the
  -- order at redemption time so a later rate change cannot rewrite past TDS figures.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                 AND table_name='redemption_orders' AND column_name='valuePaise') THEN
    ALTER TABLE "redemption_orders" ADD COLUMN "valuePaise" BIGINT;
  END IF;
END $$;
