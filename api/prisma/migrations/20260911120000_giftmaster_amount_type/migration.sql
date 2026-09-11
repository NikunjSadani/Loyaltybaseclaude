-- GiftMaster: FIXED vs FREE_AMOUNT (variable ₹) amount-type support (ADDITIVE, non-destructive).
-- Default FIXED preserves every existing master; the ₹ band columns are nullable and
-- meaningful only for FREE_AMOUNT masters (published as free-amount RewardCatalog rows).

-- CreateEnum
CREATE TYPE "GiftAmountType" AS ENUM ('FIXED', 'FREE_AMOUNT');

-- AlterTable
ALTER TABLE "gift_masters" ADD COLUMN "amountType" "GiftAmountType" NOT NULL DEFAULT 'FIXED';
ALTER TABLE "gift_masters" ADD COLUMN "minAmountPaise" INTEGER;
ALTER TABLE "gift_masters" ADD COLUMN "maxAmountPaise" INTEGER;
