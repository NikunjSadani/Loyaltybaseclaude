-- HELD OPENING BALANCES (owner-approved 2026-11-21 as a PLATFORM-WIDE mechanism; dormant unless rows exist —
-- only Bajaj will have rows initially). A migrating client's vendor closing balance + dated passbook for an outlet
-- that has no wallet yet; posted into the wallet when it is first created (KYC approval) or by a Gifsy "Apply now".
-- Additive only: one enum + one table + indexes (incl. a partial unique index: one live row per outlet). No FK (a held row may name an outlet that is not on the portal yet).
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'HeldOpeningBalanceStatus') THEN
    CREATE TYPE "HeldOpeningBalanceStatus" AS ENUM ('PENDING', 'APPLIED', 'FAILED', 'CANCELLED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "held_opening_balances" (
  "id"              TEXT NOT NULL,
  "clientId"        TEXT NOT NULL,
  "outletCode"      TEXT NOT NULL,
  "source"          TEXT NOT NULL,
  "asOfDate"        DATE,
  "closingPoints"   INTEGER NOT NULL,
  "events"          JSONB NOT NULL,
  "eventTotals"     JSONB,
  "status"          "HeldOpeningBalanceStatus" NOT NULL DEFAULT 'PENDING',
  "appliedAt"       TIMESTAMP(3),
  "appliedWalletId" TEXT,
  "applyMode"       TEXT,
  "appliedBy"       TEXT,
  "sequencing"      TEXT,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt"   TIMESTAMP(3),
  "lastError"       TEXT,
  "failureReason"   TEXT,
  "failedAt"        TIMESTAMP(3),
  "cancelledAt"     TIMESTAMP(3),
  "cancelledBy"     TEXT,
  "cancelReason"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy"       TEXT,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "held_opening_balances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "held_opening_balances_clientId_outletCode_source_key"
  ON "held_opening_balances" ("clientId", "outletCode", "source");
CREATE INDEX IF NOT EXISTS "held_opening_balances_clientId_status_idx"
  ON "held_opening_balances" ("clientId", "status");
CREATE INDEX IF NOT EXISTS "held_opening_balances_clientId_outletCode_idx"
  ON "held_opening_balances" ("clientId", "outletCode");

CREATE INDEX IF NOT EXISTS "held_opening_balances_status_lastAttemptAt_idx"
  ON "held_opening_balances" ("status", "lastAttemptAt");

-- ONE live held balance per outlet (fix round 2026-11-21, dual audit H1): a second PENDING / FAILED / APPLIED row
-- for the same (tenant, outlet) is refused by the DATABASE — reloads under a new source or a double "Apply now"
-- can never post twice. A row must be CANCELLED (audited) before a replacement can be loaded.
CREATE UNIQUE INDEX IF NOT EXISTS "held_opening_balances_one_live_per_outlet"
  ON "held_opening_balances" ("clientId", "outletCode")
  WHERE "status" IN ('PENDING', 'FAILED', 'APPLIED');

RESET lock_timeout;
