-- TDS deposits: "TDS for month" (owner-approved, platform-wide money fix A).
--
-- A deposit is assigned to the FY of the MONTH IT PAYS FOR, not the FY of its deposit date
-- (March TDS deposited on 7 April belongs to the previous FY). Additive: one nullable column,
-- a backfill, one index, and the re-upload dedup index widened to include the new column.

-- 1. The column (nullable — a row written by an older build gets the default rule at read time).
ALTER TABLE "tds_deposits" ADD COLUMN "forPeriod" TEXT;

-- 2. Backfill every existing row with the SAME default rule the upload parser applies
--    (tds.helpers defaultDepositForPeriod), evaluated on the IST wall-clock date
--    (depositDate is stored as a UTC timestamp; IST = UTC + 05:30):
--      deposit day 1–7          → the previous month
--      deposit dated 8–30 April → March of the same year
--      otherwise                → the deposit's own month
UPDATE "tds_deposits" AS d
SET "forPeriod" = CASE
    WHEN EXTRACT(DAY FROM s.ist) <= 7
      THEN to_char(date_trunc('month', s.ist) - INTERVAL '1 month', 'YYYY-MM')
    WHEN EXTRACT(MONTH FROM s.ist) = 4
      THEN to_char(s.ist, 'YYYY') || '-03'
    ELSE to_char(s.ist, 'YYYY-MM')
  END
FROM (
  SELECT "id", ("depositDate" + INTERVAL '5 hours 30 minutes') AS ist FROM "tds_deposits"
) AS s
WHERE d."id" = s."id" AND d."forPeriod" IS NULL;

-- 3. Report query index (deposits are now selected by section + forPeriod window).
CREATE INDEX "tds_deposits_section_forPeriod_idx" ON "tds_deposits"("section", "forPeriod");

-- 4. Re-upload dedup: two rows of ONE file that differ only in "TDS for month" are distinct
--    deposits. Widening the key only RELAXES the constraint, so existing rows cannot violate it.
DROP INDEX IF EXISTS "tds_deposits_dedup_unique";
CREATE UNIQUE INDEX "tds_deposits_dedup_unique"
  ON "tds_deposits" (
    (COALESCE("clientId", '')), "section", "panNumber", "depositDate", "amountPaise",
    (COALESCE("outletCode", '')), (COALESCE("forPeriod", '')), "uploadBatchId"
  )
  WHERE "uploadBatchId" IS NOT NULL;
