-- UAT hardening: DB-level integrity constraints (S0 of the fix-plan migration bundle).
--
-- Prisma cannot model PARTIAL or EXPRESSION unique indexes, so these live in the
-- migration only. The application services catch P2002 and surface a clean 4xx /
-- mark the row as a skipped duplicate.

-- ── 1. Credit reversal: at most one PENDING_GIFSY reversal per (batch, outlet, field) ──
-- DB-enforces what credits.service.ts:createReversal does racily (findFirst → create).
-- Once the prior reversal is approved/rejected (status changes), a new one is allowed
-- (partial predicate). batchId already implies clientId, so it is omitted from the key.
CREATE UNIQUE INDEX "credit_reversals_pending_unique"
  ON "credit_reversals" ("batchId", "outletId", "fieldId")
  WHERE "status" = 'PENDING_GIFSY';

-- ── 2. TDS off-platform (194R) re-upload dedup — FILE-LEVEL ──
-- uploadBatchId is set by the service to a DETERMINISTIC hash of the uploaded file's
-- rows (not a random uuid). Including it in the key makes re-uploading the SAME file a
-- no-op (every row collides → skipped + reported as "duplicate entry"), while two
-- DIFFERENT files each record their rows — so a genuine repeat 194R gift to the same
-- PAN/date/amount in a new upload is preserved. outletCode is COALESCEd so NULLs dedup.
CREATE UNIQUE INDEX "tds_off_platform_entries_dedup_unique"
  ON "tds_off_platform_entries" (
    "clientId", "section", "panNumber", "entryDate", "amountPaise",
    (COALESCE("outletCode", '')), "uploadBatchId"
  )
  WHERE "uploadBatchId" IS NOT NULL;

-- ── 3. TDS deposit (194R/194C) re-upload dedup — FILE-LEVEL ──
-- Same file-level model. clientId is nullable (194C = platform, clientId NULL) so it is
-- COALESCEd into the key alongside outletCode.
CREATE UNIQUE INDEX "tds_deposits_dedup_unique"
  ON "tds_deposits" (
    (COALESCE("clientId", '')), "section", "panNumber", "depositDate", "amountPaise",
    (COALESCE("outletCode", '')), "uploadBatchId"
  )
  WHERE "uploadBatchId" IS NOT NULL;
