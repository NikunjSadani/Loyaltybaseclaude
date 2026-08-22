-- Gift Catalogue & Dispatch (Wave 0) — schema foundation. STRICTLY ADDITIVE:
--   * 6 new enums + 4 new tables (vendors, vendor_tenant_grants, gift_categories, gift_masters)
--   * nullable / DEFAULTED columns on reward_catalog, redemption_orders, users
-- NO drops, NO renames, NO repoints, NO backfill (Wave 1 does data backfill). Every existing
-- Deoleo row stays valid: reward_catalog rows read as sourceType=PLATFORM + moderationStatus=
-- APPROVED (live), redemption_orders/users get NULL for the new nullable columns.
-- The VENDOR UserRole enum value is added in the sibling 20260821130000_gift_catalogue_vendor_role
-- migration (ADD VALUE isolated per repo convention). See GIFT-CATALOGUE-AND-DISPATCH-DESIGN.md.

-- ── New enums ──────────────────────────────────────────────────────────────────────
CREATE TYPE "GiftSourceType" AS ENUM ('PLATFORM', 'VENDOR');
CREATE TYPE "VendorStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "VendorGrantStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "GiftApprovalPolicy" AS ENUM ('AUTO_LIVE', 'GIFSY_APPROVE', 'TENANT_APPROVE', 'EITHER');
CREATE TYPE "GiftModerationStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "GiftFulfilmentChannel" AS ENUM ('FULFILLED_BY_AMAZON', 'GIFSY_WAREHOUSE', 'BRAND', 'DIGITAL_VOUCHER');
CREATE TYPE "GiftMasterStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- ── vendors — platform entity (no financial/KYC fields) ──────────────────────────────
CREATE TABLE "vendors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "VendorStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vendors_status_idx" ON "vendors"("status");

-- ── vendor_tenant_grants — deny-by-default tenant grants (mirrors gifsy_staff_tenant_grants) ──
CREATE TABLE "vendor_tenant_grants" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "approvalPolicy" "GiftApprovalPolicy" NOT NULL DEFAULT 'GIFSY_APPROVE',
    "status" "VendorGrantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vendor_tenant_grants_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "vendor_tenant_grants_vendorId_clientId_key" ON "vendor_tenant_grants"("vendorId", "clientId");
CREATE INDEX "vendor_tenant_grants_clientId_idx" ON "vendor_tenant_grants"("clientId");
CREATE INDEX "vendor_tenant_grants_vendorId_idx" ON "vendor_tenant_grants"("vendorId");

-- ── gift_categories — platform-level shared taxonomy (self-referential) ──────────────
CREATE TABLE "gift_categories" (
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gift_categories_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gift_categories_parentId_idx" ON "gift_categories"("parentId");

-- ── gift_masters — the platform-source gift authored once ────────────────────────────
CREATE TABLE "gift_masters" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrls" JSONB,
    "mrpPaise" INTEGER,
    "redemptionMode" "PayoutMode" NOT NULL,
    "defaultFulfilmentChannel" "GiftFulfilmentChannel",
    "termsAndConditions" TEXT,
    "status" "GiftMasterStatus" NOT NULL DEFAULT 'ACTIVE',
    "stockQuantity" INTEGER,
    "metadata" JSONB,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "gift_masters_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gift_masters_categoryId_idx" ON "gift_masters"("categoryId");
CREATE INDEX "gift_masters_status_idx" ON "gift_masters"("status");
CREATE INDEX "gift_masters_deletedAt_idx" ON "gift_masters"("deletedAt");

-- ── reward_catalog — additive columns (Option R: this row IS the per-tenant gift catalogue row) ──
ALTER TABLE "reward_catalog" ADD COLUMN "sourceType" "GiftSourceType" NOT NULL DEFAULT 'PLATFORM';
ALTER TABLE "reward_catalog" ADD COLUMN "giftMasterId" TEXT;
ALTER TABLE "reward_catalog" ADD COLUMN "vendorId" TEXT;
ALTER TABLE "reward_catalog" ADD COLUMN "giftCategoryId" TEXT;
ALTER TABLE "reward_catalog" ADD COLUMN "sellingValuePaise" INTEGER;
ALTER TABLE "reward_catalog" ADD COLUMN "moderationStatus" "GiftModerationStatus" NOT NULL DEFAULT 'APPROVED';
ALTER TABLE "reward_catalog" ADD COLUMN "moderationByUserId" TEXT;
ALTER TABLE "reward_catalog" ADD COLUMN "moderatedAt" TIMESTAMP(3);
ALTER TABLE "reward_catalog" ADD COLUMN "moderationReason" TEXT;
CREATE INDEX "reward_catalog_sourceType_idx" ON "reward_catalog"("sourceType");
CREATE INDEX "reward_catalog_vendorId_idx" ON "reward_catalog"("vendorId");
CREATE INDEX "reward_catalog_giftMasterId_idx" ON "reward_catalog"("giftMasterId");
CREATE INDEX "reward_catalog_giftCategoryId_idx" ON "reward_catalog"("giftCategoryId");
CREATE INDEX "reward_catalog_moderationStatus_idx" ON "reward_catalog"("moderationStatus");

-- ── redemption_orders — additive dispatch/fulfilment fields (valuePaise reused, NOT changed) ──
ALTER TABLE "redemption_orders" ADD COLUMN "fulfilmentChannel" "GiftFulfilmentChannel";
ALTER TABLE "redemption_orders" ADD COLUMN "logisticsPartner" TEXT;
ALTER TABLE "redemption_orders" ADD COLUMN "supplierOrderRef" TEXT;
ALTER TABLE "redemption_orders" ADD COLUMN "fulfilledByVendorId" TEXT;
ALTER TABLE "redemption_orders" ADD COLUMN "podUrl" TEXT;
ALTER TABLE "redemption_orders" ADD COLUMN "vendorPiiConsentAt" TIMESTAMP(3);
ALTER TABLE "redemption_orders" ADD COLUMN "consentVersion" TEXT;
CREATE INDEX "redemption_orders_fulfilledByVendorId_idx" ON "redemption_orders"("fulfilledByVendorId");

-- ── users — vendor login link (VENDOR-role context) ──────────────────────────────────
ALTER TABLE "users" ADD COLUMN "vendorId" TEXT;
CREATE INDEX "users_vendorId_idx" ON "users"("vendorId");

-- ── Foreign keys ─────────────────────────────────────────────────────────────────────
-- New-table internal FKs
ALTER TABLE "vendor_tenant_grants" ADD CONSTRAINT "vendor_tenant_grants_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "gift_categories" ADD CONSTRAINT "gift_categories_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "gift_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "gift_masters" ADD CONSTRAINT "gift_masters_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "gift_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- reward_catalog new FKs (all onDelete Restrict per §3 / Restrict; giftCategory is a plain optional link)
ALTER TABLE "reward_catalog" ADD CONSTRAINT "reward_catalog_giftCategoryId_fkey"
    FOREIGN KEY ("giftCategoryId") REFERENCES "gift_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "reward_catalog" ADD CONSTRAINT "reward_catalog_giftMasterId_fkey"
    FOREIGN KEY ("giftMasterId") REFERENCES "gift_masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reward_catalog" ADD CONSTRAINT "reward_catalog_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- redemption_orders new FK
ALTER TABLE "redemption_orders" ADD CONSTRAINT "redemption_orders_fulfilledByVendorId_fkey"
    FOREIGN KEY ("fulfilledByVendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- users new FK
ALTER TABLE "users" ADD CONSTRAINT "users_vendorId_fkey"
    FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
