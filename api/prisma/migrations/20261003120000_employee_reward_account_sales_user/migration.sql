-- Employee Rewards Phase A — link an EMPLOYEE RewardAccount to each roster employee (ADDITIVE).
-- Mirrors channel_partners.accountId (the OUTLET profile -> its account link): a nullable, unique
-- FK on the PROFILE side (sales_users) referencing reward_accounts(id) ON DELETE SET NULL. No
-- backfill, no drops. The EMPLOYEE account wiring is gated by earnerModel === 'EMPLOYEE', so the
-- TRADE path writes nothing here and stays byte-identical. The reverse relation
-- (RewardAccount.employeeProfile) is a virtual Prisma back-relation — no column.

ALTER TABLE "sales_users" ADD COLUMN "accountId" TEXT;
CREATE UNIQUE INDEX "sales_users_accountId_key" ON "sales_users"("accountId");
ALTER TABLE "sales_users" ADD CONSTRAINT "sales_users_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "reward_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
