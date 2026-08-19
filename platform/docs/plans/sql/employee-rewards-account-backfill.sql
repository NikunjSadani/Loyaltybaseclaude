-- Employee Rewards Phase 1 — RewardAccount BACK-FILL (existing outlets).
-- DRAFT for independent audit — do NOT run without audit sign-off + a backup.
-- RUN WITH:  psql -v ON_ERROR_STOP=1 -f this_file   (so a guard failure aborts the run).
-- Runs on staging first, then prod. Idempotent (re-run = no-op). Zero balance movement —
-- this only assigns account OWNERSHIP to existing partners/wallets/orders.
--
-- Scope: PHASE 1 = clientId 'deoleo' ONLY. One OUTLET RewardAccount per NON-PARENT,
-- NON-DELETED deoleo partner that lacks one; then link that account onto the partner's
-- wallet + any redemption orders. Parents (isParent=true, login-less, no wallet) get NO
-- account. Other tenants are back-filled by re-running with their clientId when they convert.
-- Prereq: run the test-data cleanup FIRST; regardless, deletedAt IS NULL never mints accounts
-- for disposable/soft-deleted partners.
--
-- ids: raw SQL generates UUID-format text ids (the oneoff image is Prisma 7 driver-adapter,
-- so raw `pg` is used, not the cuid client). The id column is TEXT; a UUID interoperates.

BEGIN;

-- Guard INSIDE the txn (audit M1): an exception here aborts the transaction, so a mis-targeted
-- run can never half-execute even without ON_ERROR_STOP.
DO $$ BEGIN
  IF current_database() NOT IN ('gifsy_staging','gifsy_prod') THEN
    RAISE EXCEPTION 'ABORT: unexpected database %', current_database();
  END IF;
END $$;

-- Before-count (deoleo only).
SELECT 'deoleo_partners_needing_account' AS metric, count(*) AS n
FROM "channel_partners"
WHERE "clientId" = 'deoleo' AND "isParent" = false AND "deletedAt" IS NULL AND "accountId" IS NULL;

-- 1. Create + link one OUTLET account per qualifying partner (correlated, single statement).
--    NOTE (maintainer): correctness DEPENDS on `to_backfill` being referenced >=2 times below
--    (by `ins` AND the outer UPDATE) so PostgreSQL MATERIALIZES it and gen_random_uuid() is
--    evaluated ONCE per partner — the SAME id is inserted as the account AND written to the
--    partner. Do NOT reduce it to a single reference or add NOT MATERIALIZED, or the ids would
--    diverge into dangling FKs.
WITH to_backfill AS (
  SELECT cp.id AS partner_id, cp."clientId" AS client_id, gen_random_uuid()::text AS new_account_id
  FROM "channel_partners" cp
  WHERE cp."clientId" = 'deoleo' AND cp."isParent" = false
    AND cp."deletedAt" IS NULL AND cp."accountId" IS NULL
),
ins AS (
  INSERT INTO "reward_accounts" (id, "clientId", "accountType", status, "createdAt", "updatedAt")
  SELECT new_account_id, client_id, 'OUTLET', 'ACTIVE', now(), now() FROM to_backfill
  RETURNING id
)
UPDATE "channel_partners" cp
SET "accountId" = tb.new_account_id
FROM to_backfill tb
WHERE cp.id = tb.partner_id;

-- 2. Link each existing wallet to its partner's account (idempotent).
UPDATE "wallets" w
SET "accountId" = cp."accountId"
FROM "channel_partners" cp
WHERE w."partnerId" = cp.id AND cp."clientId" = 'deoleo'
  AND cp."accountId" IS NOT NULL AND w."accountId" IS NULL;

-- 3. Link each existing redemption order to its partner's account (idempotent).
UPDATE "redemption_orders" o
SET "accountId" = cp."accountId"
FROM "channel_partners" cp
WHERE o."partnerId" = cp.id AND cp."clientId" = 'deoleo'
  AND cp."accountId" IS NOT NULL AND o."accountId" IS NULL;

-- After-checks (deoleo; must all be 0 = fully back-filled).
SELECT 'deoleo_partners_without_account_live' AS check, count(*) AS n
  FROM "channel_partners"
  WHERE "clientId" = 'deoleo' AND "isParent" = false AND "deletedAt" IS NULL AND "accountId" IS NULL;
SELECT 'deoleo_wallets_without_account' AS check, count(*) AS n
  FROM "wallets" w JOIN "channel_partners" cp ON cp.id = w."partnerId"
  WHERE cp."clientId" = 'deoleo' AND cp."isParent" = false AND cp."deletedAt" IS NULL AND w."accountId" IS NULL;
SELECT 'deoleo_orders_without_account' AS check, count(*) AS n
  FROM "redemption_orders" o JOIN "channel_partners" cp ON cp.id = o."partnerId"
  WHERE cp."clientId" = 'deoleo' AND cp."deletedAt" IS NULL AND o."accountId" IS NULL;

-- DRY-RUN by default: audit reviews the plan + the after-check output, THEN the executor
-- flips ROLLBACK -> COMMIT (with a backup taken first).
ROLLBACK;
-- COMMIT;
