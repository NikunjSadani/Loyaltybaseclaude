-- Employee Rewards Phase 0 — additive earner-model switch on Client.
-- CREATE TYPE + column add can share ONE migration (this is CREATE TYPE, not the
-- ALTER TYPE ADD VALUE case that must run in its own tx).
-- Additive + NOT NULL DEFAULT 'TRADE_LOYALTY' → every existing client (incl. deoleo)
-- is unchanged; no backfill needed.

CREATE TYPE "LoyaltyType" AS ENUM ('TRADE_LOYALTY', 'EMPLOYEE_REWARDS');

ALTER TABLE "clients"
  ADD COLUMN "loyaltyType" "LoyaltyType" NOT NULL DEFAULT 'TRADE_LOYALTY';
