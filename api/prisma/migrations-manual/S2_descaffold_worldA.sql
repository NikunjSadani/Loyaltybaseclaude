-- Phase S · S2 — World-A de-scaffold (canonical schema born clean)
-- Generated 2026-06-16 via: prisma migrate diff (platform 80-model -> canonical 66-model)
-- GUARDED: aborts unless current_database() = 'gifsy_dev'. Apply to dev only.

BEGIN;

DO $guard$ BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'ABORT: this migration is dev-only; expected gifsy_dev, got %', current_database();
  END IF;
END $guard$;

-- DropForeignKey
ALTER TABLE "tier_configs" DROP CONSTRAINT "tier_configs_partnerClassId_fkey";

-- DropForeignKey
ALTER TABLE "channel_partners" DROP CONSTRAINT "channel_partners_partnerClassId_fkey";

-- DropForeignKey
ALTER TABLE "channel_partners" DROP CONSTRAINT "channel_partners_currentTierConfigId_fkey";

-- DropForeignKey
ALTER TABLE "partner_tier_history" DROP CONSTRAINT "partner_tier_history_partnerId_fkey";

-- DropForeignKey
ALTER TABLE "partner_tier_history" DROP CONSTRAINT "partner_tier_history_tierConfigId_fkey";

-- DropForeignKey
ALTER TABLE "categories" DROP CONSTRAINT "categories_parentId_fkey";

-- DropForeignKey
ALTER TABLE "sku_category_mappings" DROP CONSTRAINT "sku_category_mappings_skuId_fkey";

-- DropForeignKey
ALTER TABLE "sku_category_mappings" DROP CONSTRAINT "sku_category_mappings_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "sales_invoices" DROP CONSTRAINT "sales_invoices_salesUploadId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_line_items" DROP CONSTRAINT "invoice_line_items_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_line_items" DROP CONSTRAINT "invoice_line_items_skuId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_returns" DROP CONSTRAINT "invoice_returns_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "invoice_returns" DROP CONSTRAINT "invoice_returns_skuId_fkey";

-- DropForeignKey
ALTER TABLE "scheme_rules" DROP CONSTRAINT "scheme_rules_schemeId_fkey";

-- DropForeignKey
ALTER TABLE "targets" DROP CONSTRAINT "targets_schemeId_fkey";

-- DropForeignKey
ALTER TABLE "targets" DROP CONSTRAINT "targets_partnerId_fkey";

-- DropForeignKey
ALTER TABLE "target_achievements" DROP CONSTRAINT "target_achievements_targetId_fkey";

-- DropForeignKey
ALTER TABLE "target_achievements" DROP CONSTRAINT "target_achievements_partnerId_fkey";

-- DropForeignKey
ALTER TABLE "reward_inventory" DROP CONSTRAINT "reward_inventory_rewardId_fkey";

-- DropForeignKey
ALTER TABLE "reward_inventory" DROP CONSTRAINT "reward_inventory_skuId_fkey";

-- DropIndex
DROP INDEX "channel_partners_partnerClassId_idx";

-- AlterTable
ALTER TABLE "clients" DROP COLUMN "partnerClasses";

-- AlterTable
ALTER TABLE "channel_partners" DROP COLUMN "currentTierConfigId",
DROP COLUMN "partnerClassId";

-- AlterTable
ALTER TABLE "schemes" DROP COLUMN "fixedPoints",
DROP COLUMN "maxPointsPerCycle",
DROP COLUMN "pointsPerRupee";

-- AlterTable
ALTER TABLE "scheme_eligibility" DROP COLUMN "partnerClassCode",
DROP COLUMN "tierConfigId";

-- AlterTable
ALTER TABLE "point_expiry_config" DROP COLUMN "partnerClassCode";

-- AlterTable
ALTER TABLE "reward_catalog" DROP COLUMN "eligibleClasses";

-- AlterTable
ALTER TABLE "visibility_programs" DROP COLUMN "eligibleClasses";

-- AlterTable
ALTER TABLE "leaderboard_configs" DROP COLUMN "eligibleClasses";

-- AlterTable
ALTER TABLE "banner_management" DROP COLUMN "targetClasses";

-- DropTable
DROP TABLE "channel_partner_classes";

-- DropTable
DROP TABLE "tier_configs";

-- DropTable
DROP TABLE "partner_tier_history";

-- DropTable
DROP TABLE "categories";

-- DropTable
DROP TABLE "skus";

-- DropTable
DROP TABLE "sku_category_mappings";

-- DropTable
DROP TABLE "sales_uploads";

-- DropTable
DROP TABLE "sales_invoices";

-- DropTable
DROP TABLE "invoice_line_items";

-- DropTable
DROP TABLE "invoice_returns";

-- DropTable
DROP TABLE "scheme_rules";

-- DropTable
DROP TABLE "targets";

-- DropTable
DROP TABLE "target_achievements";

-- DropTable
DROP TABLE "reward_inventory";

-- DropEnum
DROP TYPE "PartnerClassCode";

-- DropEnum
DROP TYPE "RuleType";


COMMIT;
