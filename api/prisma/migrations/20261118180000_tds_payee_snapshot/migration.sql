-- TDS payee snapshot (owner rule 2026-11-18): TDS is keyed by PAN; a PAN change splits the year at the
-- change. ADDITIVE + idempotent. NOT applied anywhere yet.
--
-- PAN normaliser (A-M2) — identical to normalisePan() / PAN_NORMALISE_SQL in api/src/tds/tds-194r.shared.ts:
--   upper(regexp_replace(x, '[ \t\n\r\f\v ​﻿]', '', 'g'))
-- (every space / tab / CR / LF / FF / VT / NBSP / zero-width space / BOM removed anywhere, then upper-cased).
-- A real PAN = non-empty after normalising AND left(…, 10) <> '__NO_PAN__'. No PAN → '__NO_PAN__:<partnerId>';
-- no owner → '__NO_PAN__:outlet:<clientId>:<outletCode>' (same as payeeKeyFor()).
SET lock_timeout = '5s';

-- AlterTable: credit_payout_entries
ALTER TABLE "credit_payout_entries" ADD COLUMN IF NOT EXISTS "payeePan" TEXT;
ALTER TABLE "credit_payout_entries" ADD COLUMN IF NOT EXISTS "payeePartnerId" TEXT;

-- AlterTable: redemption_orders
ALTER TABLE "redemption_orders" ADD COLUMN IF NOT EXISTS "payeePan" TEXT;
ALTER TABLE "redemption_orders" ADD COLUMN IF NOT EXISTS "payeePartnerId" TEXT;

-- AlterTable: tds_deposits / tds_off_platform_entries (A-H1: the 194R retailer key AS OF the upload)
ALTER TABLE "tds_deposits" ADD COLUMN IF NOT EXISTS "resolvedKey" TEXT;
ALTER TABLE "tds_off_platform_entries" ADD COLUMN IF NOT EXISTS "resolvedKey" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "credit_payout_entries_clientId_payeePan_idx" ON "credit_payout_entries"("clientId", "payeePan");

-- ── Backfill. History was not recorded before this change: the best available is (A-M1) the key a
-- POSITIVE 194R withholding was booked under, else the CURRENT outlet owner. Prod had 0 194R TDS rows.

-- (1) A-M1: an entry that already has a positive 194R ledger row takes THAT row's stored key (latest row).
UPDATE "credit_payout_entries" AS e
SET "payeePan" = l."panNumber"
FROM (
  SELECT DISTINCT ON ("creditPayoutEntryId") "creditPayoutEntryId", "panNumber"
  FROM "tds_deduction_entries"
  WHERE "section" = 'SEC_194R' AND "tdsDeductedThisPaise" > 0 AND "creditPayoutEntryId" IS NOT NULL
    AND "panNumber" IS NOT NULL AND btrim("panNumber") <> ''
  ORDER BY "creditPayoutEntryId", "createdAt" DESC, "id" DESC
) AS l
WHERE e."payeePan" IS NULL AND e."id" = l."creditPayoutEntryId";

-- (2) Every other payout already in a bank file or paid (PROCESSING / PAID): the CURRENT owner.
--     PENDING / FAILED are snapshotted when a bank file takes them.
UPDATE "credit_payout_entries" AS e
SET "payeePan" = CASE
      WHEN p."panNumber" IS NOT NULL
       AND upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')) <> ''
       AND left(upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')), 10) <> '__NO_PAN__'
        THEN upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g'))
      WHEN o."partnerId" IS NOT NULL THEN '__NO_PAN__:' || o."partnerId"
      ELSE '__NO_PAN__:outlet:' || e."clientId" || ':' || e."outletId"
    END
FROM "outlets" AS o
LEFT JOIN "channel_partners" AS p ON p."id" = o."partnerId"
WHERE e."payeePan" IS NULL
  AND e."status" IN ('PROCESSING', 'PAID')
  AND o."clientId" = e."clientId"
  AND o."outletCode" = e."outletId";

-- (3) payeePartnerId for every snapshotted entry: the current outlet owner (best available).
UPDATE "credit_payout_entries" AS e
SET "payeePartnerId" = o."partnerId"
FROM "outlets" AS o
WHERE e."payeePan" IS NOT NULL AND e."payeePartnerId" IS NULL
  AND o."clientId" = e."clientId" AND o."outletCode" = e."outletId";

-- (4) DELIVERED redemptions: the current partner.
UPDATE "redemption_orders" AS r
SET "payeePartnerId" = r."partnerId",
    "payeePan" = CASE
      WHEN p."panNumber" IS NOT NULL
       AND upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')) <> ''
       AND left(upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')), 10) <> '__NO_PAN__'
        THEN upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g'))
      ELSE '__NO_PAN__:' || r."partnerId"
    END
FROM "channel_partners" AS p
WHERE r."payeePan" IS NULL
  AND r."status" = 'DELIVERED'
  AND p."id" = r."partnerId";

-- (5) A-H1: 194R off-platform rows + 194R deposits — a PAN row → its normalised PAN; a no-PAN marker row → its
--     Outlet Code's CURRENT owner key in the same client (case-insensitive code; an ambiguous code stays NULL).
UPDATE "tds_off_platform_entries" AS t
SET "resolvedKey" = upper(regexp_replace(t."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g'))
WHERE t."resolvedKey" IS NULL AND t."section" = 'SEC_194R'
  AND upper(regexp_replace(t."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')) <> ''
  AND left(upper(regexp_replace(t."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')), 10) <> '__NO_PAN__';

UPDATE "tds_off_platform_entries" AS t
SET "resolvedKey" = CASE
      WHEN p."panNumber" IS NOT NULL
       AND upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')) <> ''
       AND left(upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')), 10) <> '__NO_PAN__'
        THEN upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g'))
      WHEN o."partnerId" IS NOT NULL THEN '__NO_PAN__:' || o."partnerId"
      ELSE '__NO_PAN__:outlet:' || o."clientId" || ':' || o."outletCode"
    END
FROM "outlets" AS o
LEFT JOIN "channel_partners" AS p ON p."id" = o."partnerId"
WHERE t."resolvedKey" IS NULL AND t."section" = 'SEC_194R' AND t."outletCode" IS NOT NULL
  AND o."clientId" = t."clientId" AND upper(o."outletCode") = upper(btrim(t."outletCode"))
  AND (SELECT count(*) FROM "outlets" o2 WHERE o2."clientId" = t."clientId" AND upper(o2."outletCode") = upper(btrim(t."outletCode"))) = 1;

UPDATE "tds_deposits" AS t
SET "resolvedKey" = upper(regexp_replace(t."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g'))
WHERE t."resolvedKey" IS NULL AND t."section" = 'SEC_194R'
  AND upper(regexp_replace(t."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')) <> ''
  AND left(upper(regexp_replace(t."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')), 10) <> '__NO_PAN__';

UPDATE "tds_deposits" AS t
SET "resolvedKey" = CASE
      WHEN p."panNumber" IS NOT NULL
       AND upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')) <> ''
       AND left(upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g')), 10) <> '__NO_PAN__'
        THEN upper(regexp_replace(p."panNumber", '[ \t\n\r\f\v ​﻿]', '', 'g'))
      WHEN o."partnerId" IS NOT NULL THEN '__NO_PAN__:' || o."partnerId"
      ELSE '__NO_PAN__:outlet:' || o."clientId" || ':' || o."outletCode"
    END
FROM "outlets" AS o
LEFT JOIN "channel_partners" AS p ON p."id" = o."partnerId"
WHERE t."resolvedKey" IS NULL AND t."section" = 'SEC_194R' AND t."outletCode" IS NOT NULL AND t."clientId" IS NOT NULL
  AND o."clientId" = t."clientId" AND upper(o."outletCode") = upper(btrim(t."outletCode"))
  AND (SELECT count(*) FROM "outlets" o2 WHERE o2."clientId" = t."clientId" AND upper(o2."outletCode") = upper(btrim(t."outletCode"))) = 1;

RESET lock_timeout;
