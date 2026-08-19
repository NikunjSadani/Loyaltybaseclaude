-- Employee Rewards Phase 1 — harden the wallet/order account FKs from SET NULL to RESTRICT
-- (independent audit, identity lane F1): a funded wallet/order's RewardAccount must never be
-- deletable out from under it. Benign for OUTLET today (partnerId fallback), but Phase-2
-- employee wallets are account-only-owned, where SET NULL would strand money owner-less.
-- Additive constraint change only; no data touched (no RewardAccount is ever deleted today).

ALTER TABLE "wallets" DROP CONSTRAINT "wallets_accountId_fkey";
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "reward_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "redemption_orders" DROP CONSTRAINT "redemption_orders_accountId_fkey";
ALTER TABLE "redemption_orders" ADD CONSTRAINT "redemption_orders_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "reward_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
