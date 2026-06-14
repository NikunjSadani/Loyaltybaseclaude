-- Migration: add_credit_batch_models
-- Adds 4 enums and 5 tables for the credits-payout system.
-- Safe to run multiple times (all statements use IF NOT EXISTS / DO $$ ... END).

-- ─── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "CreditBatchStatus" AS ENUM ('PENDING_CONFIRM', 'CONFIRMED', 'PARTIALLY_REVERSED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CreditAwardType" AS ENUM ('POINTS', 'PAYOUT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CreditReversalStatus" AS ENUM ('PENDING_GIFSY', 'APPROVED', 'PARTIAL', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CreditEntryStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Tables ───────────────────────────────────────────────────────────────────

-- credit_fields
CREATE TABLE IF NOT EXISTS "credit_fields" (
  "id"               TEXT        NOT NULL,
  "clientId"         TEXT        NOT NULL,
  "name"             TEXT        NOT NULL,
  "isActive"         BOOLEAN     NOT NULL DEFAULT true,
  "isSeparatePayout" BOOLEAN     NOT NULL DEFAULT false,
  "outletTypeAwards" JSONB       NOT NULL,
  "order"            INTEGER     NOT NULL,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "credit_fields_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "credit_fields_clientId_name_key"
  ON "credit_fields"("clientId", "name");
CREATE INDEX IF NOT EXISTS "credit_fields_clientId_idx"
  ON "credit_fields"("clientId");
CREATE INDEX IF NOT EXISTS "credit_fields_isActive_idx"
  ON "credit_fields"("isActive");

-- credit_batches
CREATE TABLE IF NOT EXISTS "credit_batches" (
  "id"             TEXT                NOT NULL,
  "clientId"       TEXT                NOT NULL,
  "batchCode"      TEXT                NOT NULL,
  "period"         TEXT                NOT NULL,
  "status"         "CreditBatchStatus" NOT NULL DEFAULT 'PENDING_CONFIRM',
  "uploadedBy"     TEXT                NOT NULL,
  "uploadedAt"     TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmedAt"    TIMESTAMP(3),
  "confirmedBy"    TEXT,
  "totalOutlets"   INTEGER             NOT NULL DEFAULT 0,
  "totalPoints"    DECIMAL(15,2)       NOT NULL DEFAULT 0,
  "totalPayoutInr" DECIMAL(15,2)       NOT NULL DEFAULT 0,
  "rows"           JSONB               NOT NULL DEFAULT '[]',
  "createdAt"      TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "credit_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "credit_batches_batchCode_key"
  ON "credit_batches"("batchCode");
CREATE INDEX IF NOT EXISTS "credit_batches_clientId_idx"
  ON "credit_batches"("clientId");
CREATE INDEX IF NOT EXISTS "credit_batches_period_idx"
  ON "credit_batches"("period");
CREATE INDEX IF NOT EXISTS "credit_batches_status_idx"
  ON "credit_batches"("status");

-- credit_payout_downloads
CREATE TABLE IF NOT EXISTS "credit_payout_downloads" (
  "id"             TEXT          NOT NULL,
  "clientId"       TEXT          NOT NULL,
  "downloadCode"   TEXT          NOT NULL,
  "period"         TEXT          NOT NULL,
  "groupType"      TEXT          NOT NULL,
  "fieldId"        TEXT,
  "fieldName"      TEXT,
  "status"         TEXT          NOT NULL DEFAULT 'OPEN',
  "downloadedBy"   TEXT          NOT NULL,
  "downloadedAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "totalAmountInr" DECIMAL(15,2) NOT NULL,
  "bankSnapshots"  JSONB         NOT NULL DEFAULT '[]',
  "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "credit_payout_downloads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "credit_payout_downloads_downloadCode_key"
  ON "credit_payout_downloads"("downloadCode");
CREATE INDEX IF NOT EXISTS "credit_payout_downloads_clientId_idx"
  ON "credit_payout_downloads"("clientId");
CREATE INDEX IF NOT EXISTS "credit_payout_downloads_period_idx"
  ON "credit_payout_downloads"("period");
CREATE INDEX IF NOT EXISTS "credit_payout_downloads_status_idx"
  ON "credit_payout_downloads"("status");

-- credit_payout_entries
CREATE TABLE IF NOT EXISTS "credit_payout_entries" (
  "id"         TEXT                NOT NULL,
  "clientId"   TEXT                NOT NULL,
  "batchId"    TEXT                NOT NULL,
  "downloadId" TEXT,
  "outletId"   TEXT                NOT NULL,
  "outletName" TEXT                NOT NULL,
  "fieldId"    TEXT                NOT NULL,
  "fieldName"  TEXT                NOT NULL,
  "period"     TEXT                NOT NULL,
  "amountInr"  DECIMAL(15,2)       NOT NULL,
  "narration"  TEXT                NOT NULL DEFAULT '',
  "status"     "CreditEntryStatus" NOT NULL DEFAULT 'PENDING',
  "utr"        TEXT,
  "paidAt"     TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "credit_payout_entries_pkey"     PRIMARY KEY ("id"),
  CONSTRAINT "credit_payout_entries_batchId_fkey"
    FOREIGN KEY ("batchId")
    REFERENCES "credit_batches"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "credit_payout_entries_downloadId_fkey"
    FOREIGN KEY ("downloadId")
    REFERENCES "credit_payout_downloads"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "credit_payout_entries_clientId_idx"
  ON "credit_payout_entries"("clientId");
CREATE INDEX IF NOT EXISTS "credit_payout_entries_batchId_idx"
  ON "credit_payout_entries"("batchId");
CREATE INDEX IF NOT EXISTS "credit_payout_entries_outletId_idx"
  ON "credit_payout_entries"("outletId");
CREATE INDEX IF NOT EXISTS "credit_payout_entries_period_idx"
  ON "credit_payout_entries"("period");
CREATE INDEX IF NOT EXISTS "credit_payout_entries_status_idx"
  ON "credit_payout_entries"("status");

-- credit_reversals
CREATE TABLE IF NOT EXISTS "credit_reversals" (
  "id"              TEXT                 NOT NULL,
  "clientId"        TEXT                 NOT NULL,
  "batchId"         TEXT                 NOT NULL,
  "outletId"        TEXT                 NOT NULL,
  "outletName"      TEXT                 NOT NULL,
  "fieldId"         TEXT                 NOT NULL,
  "fieldName"       TEXT                 NOT NULL,
  "period"          TEXT                 NOT NULL,
  "awardType"       "CreditAwardType"    NOT NULL,
  "originalAmount"  DECIMAL(15,2)        NOT NULL,
  "requestedAmount" DECIMAL(15,2)        NOT NULL,
  "approvedAmount"  DECIMAL(15,2),
  "requestedBy"     TEXT                 NOT NULL,
  "requestedAt"     TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedBy"      TEXT,
  "approvedAt"      TIMESTAMP(3),
  "status"          "CreditReversalStatus" NOT NULL DEFAULT 'PENDING_GIFSY',
  "remarks"         TEXT,
  "createdAt"       TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "credit_reversals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credit_reversals_batchId_fkey"
    FOREIGN KEY ("batchId")
    REFERENCES "credit_batches"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "credit_reversals_clientId_idx"
  ON "credit_reversals"("clientId");
CREATE INDEX IF NOT EXISTS "credit_reversals_batchId_idx"
  ON "credit_reversals"("batchId");
CREATE INDEX IF NOT EXISTS "credit_reversals_outletId_idx"
  ON "credit_reversals"("outletId");
CREATE INDEX IF NOT EXISTS "credit_reversals_status_idx"
  ON "credit_reversals"("status");
