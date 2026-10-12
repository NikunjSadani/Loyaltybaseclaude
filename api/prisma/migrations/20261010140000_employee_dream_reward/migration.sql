-- Employee Rewards Wave 4 (Dream Reward) — the employee's ONE chosen aspirational catalogue reward.
-- STRICTLY ADDITIVE: a single nullable column on reward_accounts; no existing column/table touched.
-- It is a DEFERRED/soft reference (NO hard FK): the id is validated on write and self-healed on read
-- (a dream that no longer qualifies reads as cleared). OUTLET accounts never set it and no trade read
-- touches it, so the live Deoleo/trade path is byte-unchanged. Unused until an employee sets a dream.

-- AlterTable
ALTER TABLE "reward_accounts" ADD COLUMN "dreamRewardId" TEXT;
