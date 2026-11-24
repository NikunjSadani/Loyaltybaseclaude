-- TDS RECOVERY → BANK RUN LINK (owner-approved 2026-11-24, PLATFORM-WIDE; fund reconciliation). Additive + idempotent:
-- one NULLABLE column + one index. Existing rows stay NULL (no backfill); every new row written by a bank-file download
-- carries that download's id. Nothing reads it except the fund statement (194C TDS dated with its own bank run).
SET lock_timeout = '5s';

ALTER TABLE "tds_recovery_entries" ADD COLUMN IF NOT EXISTS "downloadId" TEXT;
CREATE INDEX IF NOT EXISTS "tds_recovery_entries_downloadId_idx" ON "tds_recovery_entries" ("downloadId");

RESET lock_timeout;
