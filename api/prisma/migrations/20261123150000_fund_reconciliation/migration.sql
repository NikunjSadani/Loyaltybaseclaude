-- FUND RECONCILIATION (owner-approved design 2026-11-23, platform-wide; FUND-RECONCILIATION-DESIGN.md).
-- Additive + idempotent: 3 enums, 2 new tables (fund_settings, fund_rates), 2 nullable/defaulted columns on the
-- existing (prod-EMPTY) fund_receipts table + a per-client unique receipt number + a partial unique index that
-- allows ONE opening balance per client. No data is rewritten. fund_ledger is left untouched (deprecated, unused).
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FundEntryType') THEN
    CREATE TYPE "FundEntryType" AS ENUM ('RECEIPT', 'ADJUSTMENT', 'OPENING_BALANCE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FundRateKind') THEN
    CREATE TYPE "FundRateKind" AS ENUM ('AGENCY_FEE', 'VOUCHER_DISCOUNT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FundFeeType') THEN
    CREATE TYPE "FundFeeType" AS ENUM ('PERCENT', 'FLAT');
  END IF;
END $$;

-- fund_receipts: entry type (existing rows — none on prod — read as RECEIPT) + adjustment reason.
ALTER TABLE "fund_receipts" ADD COLUMN IF NOT EXISTS "entryType" "FundEntryType" NOT NULL DEFAULT 'RECEIPT';
ALTER TABLE "fund_receipts" ADD COLUMN IF NOT EXISTS "reason" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "fund_receipts_clientId_receiptNumber_key"
  ON "fund_receipts" ("clientId", "receiptNumber");
CREATE INDEX IF NOT EXISTS "fund_receipts_clientId_entryType_idx"
  ON "fund_receipts" ("clientId", "entryType");
-- ONE opening balance per client, enforced by the database (a correction is an ADJUSTMENT, never a 2nd opening).
CREATE UNIQUE INDEX IF NOT EXISTS "fund_receipts_one_opening_per_client"
  ON "fund_receipts" ("clientId")
  WHERE "entryType" = 'OPENING_BALANCE';

CREATE TABLE IF NOT EXISTS "fund_settings" (
  "clientId"                 TEXT NOT NULL,
  "lowBalanceThresholdPaise" BIGINT,
  "alertRecipients"          JSONB NOT NULL DEFAULT '[]',
  "lowAlertLastSentOn"       TEXT,
  "lowAlertLastError"        TEXT,
  "updatedById"              TEXT,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fund_settings_pkey" PRIMARY KEY ("clientId")
);

CREATE TABLE IF NOT EXISTS "fund_rates" (
  "id"            TEXT NOT NULL,
  "clientId"      TEXT NOT NULL,
  "kind"          "FundRateKind" NOT NULL,
  "brandKey"      TEXT,
  "brandLabel"    TEXT,
  "feeType"       "FundFeeType",
  "rateBps"       INTEGER,
  "flatPaise"     BIGINT,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "note"          TEXT,
  "createdById"   TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fund_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "fund_rates_clientId_kind_effectiveFrom_idx"
  ON "fund_rates" ("clientId", "kind", "effectiveFrom");

RESET lock_timeout;
