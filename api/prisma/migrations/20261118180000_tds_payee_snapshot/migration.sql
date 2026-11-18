-- TDS payee snapshot (owner rule 2026-11-18): TDS is keyed by PAN; a PAN change splits the year at the
-- change. ADDITIVE + idempotent. NOT applied anywhere yet.
SET lock_timeout = '5s';

-- AlterTable: credit_payout_entries
ALTER TABLE "credit_payout_entries" ADD COLUMN IF NOT EXISTS "payeePan" TEXT;
ALTER TABLE "credit_payout_entries" ADD COLUMN IF NOT EXISTS "payeePartnerId" TEXT;

-- AlterTable: redemption_orders
ALTER TABLE "redemption_orders" ADD COLUMN IF NOT EXISTS "payeePan" TEXT;
ALTER TABLE "redemption_orders" ADD COLUMN IF NOT EXISTS "payeePartnerId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "credit_payout_entries_clientId_payeePan_idx" ON "credit_payout_entries"("clientId", "payeePan");

-- Backfill (history was not recorded before this change — the best available is the CURRENT outlet owner).
-- Only payouts already in a bank file or paid (PROCESSING / PAID) — PENDING / FAILED are snapshotted when a
-- bank file takes them. A real PAN = non-blank and not a `__NO_PAN__` sentinel → upper(btrim()); otherwise the
-- no-PAN owner key; an outlet with no owner → the per-outlet key. Prod had 0 194R TDS ledger rows at the change.
UPDATE "credit_payout_entries" AS e
SET "payeePartnerId" = o."partnerId",
    "payeePan" = CASE
      WHEN p."panNumber" IS NOT NULL AND btrim(p."panNumber") <> '' AND upper(btrim(p."panNumber")) NOT LIKE '\_\_NO\_PAN\_\_%'
        THEN upper(btrim(p."panNumber"))
      WHEN o."partnerId" IS NOT NULL THEN '__NO_PAN__:' || o."partnerId"
      ELSE '__NO_PAN__:outlet:' || e."clientId" || ':' || e."outletId"
    END
FROM "outlets" AS o
LEFT JOIN "channel_partners" AS p ON p."id" = o."partnerId"
WHERE e."payeePan" IS NULL
  AND e."status" IN ('PROCESSING', 'PAID')
  AND o."clientId" = e."clientId"
  AND o."outletCode" = e."outletId";

UPDATE "redemption_orders" AS r
SET "payeePartnerId" = r."partnerId",
    "payeePan" = CASE
      WHEN p."panNumber" IS NOT NULL AND btrim(p."panNumber") <> '' AND upper(btrim(p."panNumber")) NOT LIKE '\_\_NO\_PAN\_\_%'
        THEN upper(btrim(p."panNumber"))
      ELSE '__NO_PAN__:' || r."partnerId"
    END
FROM "channel_partners" AS p
WHERE r."payeePan" IS NULL
  AND r."status" = 'DELIVERED'
  AND p."id" = r."partnerId";

RESET lock_timeout;
