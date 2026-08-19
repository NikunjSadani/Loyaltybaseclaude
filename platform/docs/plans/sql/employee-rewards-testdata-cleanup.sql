-- =============================================================================
-- DRAFT for independent audit — do NOT run without audit sign-off + a backup.
-- =============================================================================
-- Purpose : Phase-0.3 test-data cleanup for the Employee Rewards / RewardAccount
--           build. Removes ONLY disposable test data so Phase 1 starts from a true
--           zero-balance slate of ONLY the 6 real "Gawde Sir" wallets.
--
-- What it deletes (and NOTHING else):
--   1. The wallets (+ their wallet_transactions + points_ledger rows) belonging to
--      SOFT-DELETED channel_partners (deletedAt IS NOT NULL) for clientId 'deoleo'
--      — i.e. the test partners `niinj` (WHOLESALER, 300 test pts) and `Payel Ghosh`
--      (0 bal). Keyed on the STABLE predicate "soft-deleted partner ownership",
--      never on partner names.
--   2. The 5 CONFIRMED test credit batches CB-2026-06-001 .. CB-2026-06-005 for
--      clientId 'deoleo' (+ their child credit_payout_entries / credit_reversals),
--      keyed on the EXPLICIT batchCode list. Guarded to also assert period='2026-06'.
--
-- Audit L4 (informational — pre-exec check, not a blocker): the 4 payout test batches
-- (CB-2026-06-002..005) MAY have `credit_payout_downloads` and/or the entries may carry an
-- `autoInvoiceId` (194C). Those parent rows are NOT deleted here (the deleted rows are the
-- children; the FKs point outward, so no FK error) and do NOT affect the zero-balance wallet
-- slate. For a truly spotless slate, the executor should confirm the 5 batches have no
-- download/auto-invoice children (194C is dormant in prod, so autoInvoiceId is expected NULL);
-- extend the delete only if such residue is found + a clean sweep is wanted.
--
-- What it MUST NEVER touch:
--   * Any wallet / channel_partner where deletedAt IS NULL  → the 6 real Gawde Sir
--     wallets (each 0 balance) stay 100% intact.
--   * The parent `Food Junction` (isParent, login-less, no wallet) and the group
--     model (groupId / PAN) — untouched.
--
-- Safety model:
--   * Hard DB guard: aborts unless current_database() = 'gifsy_prod'.
--   * Wrapped in a transaction and left as a DRY RUN (BEGIN ... ROLLBACK).
--     The executor flips ROLLBACK -> COMMIT ONLY after audit sign-off + backup.
--   * Run with:  psql -v ON_ERROR_STOP=1 -f employee-rewards-testdata-cleanup.sql
--     (ON_ERROR_STOP makes the RAISE guards actually halt the script.)
--
-- Column/table notes (verified against api/prisma/schema.prisma):
--   * Table names are @@map snake_case; COLUMN names are Prisma camelCase (unmapped)
--     → they MUST be double-quoted in raw SQL: "clientId", "deletedAt", "partnerId",
--     "walletId", "batchCode", "period", "batchId".
--   * clients.id IS the tenant slug → clientId = 'deoleo' (no lookup needed).
--   * FK cascade: wallet_transactions.walletId and points_ledger.walletId are
--     ON DELETE CASCADE from wallets; credit_payout_entries.batchId and
--     credit_reversals.batchId are NOT cascade (Prisma default RESTRICT) → children
--     are deleted EXPLICITLY first, in FK-safe order.
-- =============================================================================

-- ── GUARD 1: wrong database → abort immediately ──────────────────────────────
DO $guard$
BEGIN
  IF current_database() <> 'gifsy_prod' THEN
    RAISE EXCEPTION 'ABORT: this script targets gifsy_prod only; current_database() = %', current_database();
  END IF;
END
$guard$;

BEGIN;  -- ⇩ DRY RUN: this transaction ends in ROLLBACK at the bottom. ⇩

-- ── GUARD 2: the 5 named batches must all be period '2026-06' (else abort) ────
-- Defends against deleting a same-code batch that isn't the 2026-06 test set.
DO $period$
DECLARE
  bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count
  FROM credit_batches
  WHERE "clientId" = 'deoleo'
    AND "batchCode" IN ('CB-2026-06-001','CB-2026-06-002','CB-2026-06-003','CB-2026-06-004','CB-2026-06-005')
    AND "period" <> '2026-06';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'ABORT: % of the named batchCodes are NOT period 2026-06 — refusing to delete.', bad_count;
  END IF;
END
$period$;

-- =============================================================================
-- BEFORE: sanity-count exactly what will be deleted (review these before COMMIT).
-- =============================================================================

-- (A) Disposable wallets = wallets owned by SOFT-DELETED deoleo partners.
SELECT 'before: disposable wallets' AS label, count(*) AS n
FROM wallets w
JOIN channel_partners cp ON cp.id = w."partnerId"
WHERE cp."clientId" = 'deoleo'
  AND cp."deletedAt" IS NOT NULL;

-- (A') Their child rows (should be deleted alongside the wallets).
SELECT 'before: wallet_transactions of disposable wallets' AS label, count(*) AS n
FROM wallet_transactions wt
WHERE wt."walletId" IN (
  SELECT w.id FROM wallets w
  JOIN channel_partners cp ON cp.id = w."partnerId"
  WHERE cp."clientId" = 'deoleo' AND cp."deletedAt" IS NOT NULL
);

SELECT 'before: points_ledger of disposable wallets' AS label, count(*) AS n
FROM points_ledger pl
WHERE pl."walletId" IN (
  SELECT w.id FROM wallets w
  JOIN channel_partners cp ON cp.id = w."partnerId"
  WHERE cp."clientId" = 'deoleo' AND cp."deletedAt" IS NOT NULL
);

-- (B) The 5 test credit batches + their children.
SELECT 'before: test credit_batches' AS label, count(*) AS n
FROM credit_batches
WHERE "clientId" = 'deoleo'
  AND "batchCode" IN ('CB-2026-06-001','CB-2026-06-002','CB-2026-06-003','CB-2026-06-004','CB-2026-06-005');

SELECT 'before: credit_payout_entries of test batches' AS label, count(*) AS n
FROM credit_payout_entries
WHERE "batchId" IN (
  SELECT id FROM credit_batches
  WHERE "clientId" = 'deoleo'
    AND "batchCode" IN ('CB-2026-06-001','CB-2026-06-002','CB-2026-06-003','CB-2026-06-004','CB-2026-06-005')
);

SELECT 'before: credit_reversals of test batches' AS label, count(*) AS n
FROM credit_reversals
WHERE "batchId" IN (
  SELECT id FROM credit_batches
  WHERE "clientId" = 'deoleo'
    AND "batchCode" IN ('CB-2026-06-001','CB-2026-06-002','CB-2026-06-003','CB-2026-06-004','CB-2026-06-005')
);

-- (C) CONTROL: the 6 REAL wallets that must remain UNTOUCHED (deletedAt IS NULL).
--     Record this count now; re-run the identical SELECT after COMMIT — it must be
--     unchanged (expected 6), and every balance must be identical (all 0).
SELECT 'CONTROL: real (deletedAt IS NULL) deoleo wallets — MUST be untouched' AS label, count(*) AS n
FROM wallets w
JOIN channel_partners cp ON cp.id = w."partnerId"
WHERE cp."clientId" = 'deoleo'
  AND cp."deletedAt" IS NULL;

-- =============================================================================
-- DELETES (FK-safe order). All predicates key on stable columns only:
--   soft-deleted partner ownership  +  the explicit batchCode list.
-- =============================================================================

-- 1a. points_ledger of disposable wallets.
DELETE FROM points_ledger pl
WHERE pl."walletId" IN (
  SELECT w.id FROM wallets w
  JOIN channel_partners cp ON cp.id = w."partnerId"
  WHERE cp."clientId" = 'deoleo' AND cp."deletedAt" IS NOT NULL
);

-- 1b. wallet_transactions of disposable wallets.
DELETE FROM wallet_transactions wt
WHERE wt."walletId" IN (
  SELECT w.id FROM wallets w
  JOIN channel_partners cp ON cp.id = w."partnerId"
  WHERE cp."clientId" = 'deoleo' AND cp."deletedAt" IS NOT NULL
);

-- 1c. the disposable wallets themselves (partner rows are LEFT AS-IS — only the wallet goes).
DELETE FROM wallets w
USING channel_partners cp
WHERE cp.id = w."partnerId"
  AND cp."clientId" = 'deoleo'
  AND cp."deletedAt" IS NOT NULL;

-- 2a. child credit_payout_entries of the 5 test batches.
DELETE FROM credit_payout_entries
WHERE "batchId" IN (
  SELECT id FROM credit_batches
  WHERE "clientId" = 'deoleo'
    AND "batchCode" IN ('CB-2026-06-001','CB-2026-06-002','CB-2026-06-003','CB-2026-06-004','CB-2026-06-005')
);

-- 2b. child credit_reversals of the 5 test batches.
DELETE FROM credit_reversals
WHERE "batchId" IN (
  SELECT id FROM credit_batches
  WHERE "clientId" = 'deoleo'
    AND "batchCode" IN ('CB-2026-06-001','CB-2026-06-002','CB-2026-06-003','CB-2026-06-004','CB-2026-06-005')
);

-- 2c. the 5 test credit batches.
DELETE FROM credit_batches
WHERE "clientId" = 'deoleo'
  AND "batchCode" IN ('CB-2026-06-001','CB-2026-06-002','CB-2026-06-003','CB-2026-06-004','CB-2026-06-005');

-- =============================================================================
-- AFTER: re-run the same counts to confirm the deletes + prove the 6 real
--        wallets are untouched (label C must still return 6).
-- =============================================================================
SELECT 'after: disposable wallets (expect 0)' AS label, count(*) AS n
FROM wallets w
JOIN channel_partners cp ON cp.id = w."partnerId"
WHERE cp."clientId" = 'deoleo' AND cp."deletedAt" IS NOT NULL;

SELECT 'after: test credit_batches (expect 0)' AS label, count(*) AS n
FROM credit_batches
WHERE "clientId" = 'deoleo'
  AND "batchCode" IN ('CB-2026-06-001','CB-2026-06-002','CB-2026-06-003','CB-2026-06-004','CB-2026-06-005');

SELECT 'after: CONTROL real deoleo wallets (expect UNCHANGED = 6)' AS label, count(*) AS n
FROM wallets w
JOIN channel_partners cp ON cp.id = w."partnerId"
WHERE cp."clientId" = 'deoleo' AND cp."deletedAt" IS NULL;

-- =============================================================================
-- DRY RUN: leave as ROLLBACK. After audit sign-off + a verified backup, the
-- executor comments out ROLLBACK and uncomments COMMIT (exactly one active).
-- =============================================================================
ROLLBACK;
-- COMMIT;
