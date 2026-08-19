-- Employee Rewards Phase 1 — unified RewardAccount (ADDITIVE).
-- New table + enum + nullable owner FKs on wallets / redemption_orders / channel_partners.
-- partnerId is KEPT on wallets + redemption_orders (the outlet profile link) so the
-- outlet-compliance code (KYC/GST/TDS/payouts/invoices) is untouched. No drops, no backfill
-- here — the partner->account back-fill runs as a separate, guarded, audited data op.

CREATE TYPE "AccountType" AS ENUM ('OUTLET', 'EMPLOYEE');

CREATE TABLE "reward_accounts" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "accountType" "AccountType" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "reward_accounts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "reward_accounts_clientId_idx" ON "reward_accounts"("clientId");

-- wallets.accountId (unique 1:1 owner)
ALTER TABLE "wallets" ADD COLUMN "accountId" TEXT;
CREATE UNIQUE INDEX "wallets_accountId_key" ON "wallets"("accountId");
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "reward_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- redemption_orders.accountId
ALTER TABLE "redemption_orders" ADD COLUMN "accountId" TEXT;
CREATE INDEX "redemption_orders_accountId_idx" ON "redemption_orders"("accountId");
ALTER TABLE "redemption_orders" ADD CONSTRAINT "redemption_orders_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "reward_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- channel_partners.accountId (unique link: outlet profile -> its account)
ALTER TABLE "channel_partners" ADD COLUMN "accountId" TEXT;
CREATE UNIQUE INDEX "channel_partners_accountId_key" ON "channel_partners"("accountId");
ALTER TABLE "channel_partners" ADD CONSTRAINT "channel_partners_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "reward_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
