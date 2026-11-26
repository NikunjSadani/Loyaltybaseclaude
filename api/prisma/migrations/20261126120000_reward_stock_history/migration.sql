-- REWARD STOCK HISTORY (owner-approved 2026-11-26 for ALL clients incl. Deoleo): an append-only ledger of every
-- change to a tracked reward_catalog."stockQuantity" (OPENING / REDEEMED / RETURNED / ADJUSTED), written by the API
-- in the same transaction as the stock change, plus a review list for cancelled orders whose stock may have been
-- taken BEFORE this history existed (never auto-returned).
-- BASELINE: every reward that tracks stock right now gets ONE "OPENING" row = its current stock, labelled
-- 'Baseline at go-live of stock history'. Earlier movements are not reconstructed (the screens say so).
-- Additive only: two enums + two tables + indexes + the baseline insert. No FKs. Re-runnable (IF NOT EXISTS /
-- NOT EXISTS guards; the baseline only inserts for a reward with no ledger row yet).
SET lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RewardStockMovementType') THEN
    CREATE TYPE "RewardStockMovementType" AS ENUM ('OPENING', 'REDEEMED', 'RETURNED', 'ADJUSTED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'RewardStockReviewStatus') THEN
    CREATE TYPE "RewardStockReviewStatus" AS ENUM ('OPEN', 'RETURNED', 'KEPT');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "reward_stock_movements" (
  "id"           TEXT NOT NULL,
  "clientId"     TEXT NOT NULL,
  "rewardId"     TEXT NOT NULL,
  "type"         "RewardStockMovementType" NOT NULL,
  "quantity"     INTEGER NOT NULL,
  "balanceAfter" INTEGER,
  "orderId"      TEXT,
  "reason"       TEXT,
  "actorId"      TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reward_stock_movements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "reward_stock_movements_clientId_rewardId_createdAt_idx"
  ON "reward_stock_movements" ("clientId", "rewardId", "createdAt");
CREATE INDEX IF NOT EXISTS "reward_stock_movements_rewardId_createdAt_idx"
  ON "reward_stock_movements" ("rewardId", "createdAt");
CREATE INDEX IF NOT EXISTS "reward_stock_movements_orderId_idx"
  ON "reward_stock_movements" ("orderId");
-- At most ONE stock take and ONE stock return per order (the idempotency backstop: a double cancel can never
-- return stock twice, a double confirm can never take it twice).
CREATE UNIQUE INDEX IF NOT EXISTS "reward_stock_movements_order_redeemed_key"
  ON "reward_stock_movements" ("orderId") WHERE "type" = 'REDEEMED';
CREATE UNIQUE INDEX IF NOT EXISTS "reward_stock_movements_order_returned_key"
  ON "reward_stock_movements" ("orderId") WHERE "type" = 'RETURNED';

CREATE TABLE IF NOT EXISTS "reward_stock_reviews" (
  "id"             TEXT NOT NULL,
  "clientId"       TEXT NOT NULL,
  "rewardId"       TEXT NOT NULL,
  "orderId"        TEXT NOT NULL,
  "orderNumber"    TEXT NOT NULL,
  "quantity"       INTEGER NOT NULL,
  "orderStatus"    "RedemptionStatus" NOT NULL,
  "status"         "RewardStockReviewStatus" NOT NULL DEFAULT 'OPEN',
  "resolvedById"   TEXT,
  "resolvedAt"     TIMESTAMP(3),
  "resolutionNote" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reward_stock_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "reward_stock_reviews_orderId_key" ON "reward_stock_reviews" ("orderId");
CREATE INDEX IF NOT EXISTS "reward_stock_reviews_clientId_status_idx" ON "reward_stock_reviews" ("clientId", "status");
CREATE INDEX IF NOT EXISTS "reward_stock_reviews_rewardId_idx" ON "reward_stock_reviews" ("rewardId");

-- Baseline at go-live: one OPENING row per reward that tracks stock now (soft-deleted rows included, so a late
-- cancel of an order on a removed reward is still judged against a baseline). Skips any reward already in the ledger.
INSERT INTO "reward_stock_movements" ("id", "clientId", "rewardId", "type", "quantity", "balanceAfter", "orderId", "reason", "actorId", "createdAt")
SELECT 'rsm_' || replace(gen_random_uuid()::text, '-', ''), r."clientId", r."id", 'OPENING', r."stockQuantity", r."stockQuantity",
       NULL, 'Baseline at go-live of stock history', NULL, CURRENT_TIMESTAMP
FROM "reward_catalog" r
WHERE r."stockQuantity" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "reward_stock_movements" m WHERE m."rewardId" = r."id");

RESET lock_timeout;
