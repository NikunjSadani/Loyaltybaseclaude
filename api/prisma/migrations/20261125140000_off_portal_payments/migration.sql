-- OFF-PORTAL PAYMENTS REGISTER (owner-approved 2026-11-25, platform-wide, all clients incl. Deoleo).
-- Payments already made outside the portal, recorded by a Gifsy admin so TDS (194R / 194C), Fund Reconciliation and
-- the outlet's payout history include them. Additive only: one enum + three tables + indexes (incl. a partial unique
-- index Prisma cannot model). No FKs, no data rewritten. Re-runnable (IF NOT EXISTS everywhere).
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OffPortalPaymentMode') THEN
    CREATE TYPE "OffPortalPaymentMode" AS ENUM ('CASH', 'GIFT');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "off_portal_payment_uploads" (
  "id"            TEXT NOT NULL,
  "clientId"      TEXT NOT NULL,
  "fileName"      TEXT NOT NULL,
  "fileKey"       TEXT,
  "fileSha256"    TEXT NOT NULL,
  "rowsInFile"    INTEGER NOT NULL,
  "recordedCount" INTEGER NOT NULL,
  "skippedCount"  INTEGER NOT NULL,
  "totalPaise"    BIGINT NOT NULL,
  "acknowledged"  JSONB NOT NULL,
  "uploadedById"  TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "off_portal_payment_uploads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "off_portal_payment_uploads_clientId_createdAt_idx"
  ON "off_portal_payment_uploads" ("clientId", "createdAt");

CREATE TABLE IF NOT EXISTS "off_portal_payees" (
  "id"                TEXT NOT NULL,
  "clientId"          TEXT NOT NULL,
  "outletCode"        TEXT NOT NULL,
  "outletCodeKey"     TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "phone"             TEXT,
  "panNumber"         TEXT,
  "bankAccountNumber" TEXT,
  "ifsc"              TEXT,
  "upiId"             TEXT,
  "createdById"       TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "off_portal_payees_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "off_portal_payees_clientId_outletCodeKey_key"
  ON "off_portal_payees" ("clientId", "outletCodeKey");

CREATE TABLE IF NOT EXISTS "off_portal_payments" (
  "id"                           TEXT NOT NULL,
  "clientId"                     TEXT NOT NULL,
  "uploadId"                     TEXT NOT NULL,
  "rowNumber"                    INTEGER NOT NULL,
  "outletCode"                   TEXT NOT NULL,
  "outletCodeKey"                TEXT NOT NULL,
  "outletName"                   TEXT NOT NULL,
  "onPortalAtUpload"             BOOLEAN NOT NULL,
  "phone"                        TEXT,
  "filePan"                      TEXT,
  "portalPan"                    TEXT,
  "panNumber"                    TEXT,
  "bankAccountNumber"            TEXT,
  "ifsc"                         TEXT,
  "upiId"                        TEXT,
  "amountPaise"                  BIGINT NOT NULL,
  "paymentDate"                  TIMESTAMP(3) NOT NULL,
  "utr"                          TEXT,
  "payoutStream"                 "PayoutStream" NOT NULL,
  "paymentMode"                  "OffPortalPaymentMode" NOT NULL,
  "period"                       TEXT NOT NULL,
  "narration"                    TEXT,
  "tdsSection"                   "TdsSection" NOT NULL,
  "tdsMethodology"               "TdsMethodology" NOT NULL,
  "flags"                        JSONB NOT NULL DEFAULT '[]',
  "supersedesOffPlatformEntryId" TEXT,
  "voidedAt"                     TIMESTAMP(3),
  "voidedById"                   TEXT,
  "voidReason"                   TEXT,
  "createdById"                  TEXT NOT NULL,
  "createdAt"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "off_portal_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "off_portal_payments_amount_positive" CHECK ("amountPaise" > 0)
);
CREATE INDEX IF NOT EXISTS "off_portal_payments_clientId_outletCodeKey_idx"
  ON "off_portal_payments" ("clientId", "outletCodeKey");
CREATE INDEX IF NOT EXISTS "off_portal_payments_clientId_paymentDate_idx"
  ON "off_portal_payments" ("clientId", "paymentDate");
CREATE INDEX IF NOT EXISTS "off_portal_payments_uploadId_idx"
  ON "off_portal_payments" ("uploadId");
CREATE INDEX IF NOT EXISTS "off_portal_payments_supersedesOffPlatformEntryId_idx"
  ON "off_portal_payments" ("supersedesOffPlatformEntryId");
-- A legacy TDS off-platform marker row is replaced by AT MOST ONE live (not voided) off-portal payment — so it is
-- never subtracted twice. A voided payment releases the marker (it counts again).
CREATE UNIQUE INDEX IF NOT EXISTS "off_portal_payments_one_live_supersede"
  ON "off_portal_payments" ("supersedesOffPlatformEntryId")
  WHERE "supersedesOffPlatformEntryId" IS NOT NULL AND "voidedAt" IS NULL;

-- 194C gross-up TDS / no-PAN recovery raised when off-portal payments are recorded: the upload that wrote the row
-- (downloadId stays NULL). Nullable, additive.
ALTER TABLE "tds_recovery_entries" ADD COLUMN IF NOT EXISTS "offPortalUploadId" TEXT;
CREATE INDEX IF NOT EXISTS "tds_recovery_entries_offPortalUploadId_idx"
  ON "tds_recovery_entries" ("offPortalUploadId");

RESET lock_timeout;
