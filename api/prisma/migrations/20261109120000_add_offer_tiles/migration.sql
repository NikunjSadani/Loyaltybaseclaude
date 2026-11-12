-- Offer tiles ("This month's offers" on the partner dashboard). ADDITIVE ONLY:
-- 2 new enum types + 1 new table + 2 indexes. No existing table touched -> every tenant byte-identical.
-- Generated with `prisma migrate diff` (HEAD schema -> working schema). See platform/docs/plans/OFFER-TILES-PLAN.md.

-- CreateEnum
CREATE TYPE "OfferGroup" AS ENUM ('TARGET_REWARD', 'EXTRA_SCHEME');

-- CreateEnum
CREATE TYPE "OfferValueType" AS ENUM ('POINTS', 'PERCENT', 'RUPEES', 'TEXT');

-- CreateTable
CREATE TABLE "offer_tiles" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "group" "OfferGroup" NOT NULL,
    "valueType" "OfferValueType" NOT NULL,
    "valueNumber" DECIMAL(12,2),
    "valueText" TEXT,
    "unitLabel" TEXT,
    "product" TEXT,
    "label" TEXT NOT NULL,
    "details" TEXT,
    "validFrom" DATE NOT NULL,
    "validTo" DATE NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "programNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outletTypeCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "zones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "states" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kpiCode" TEXT,
    "copiedFromId" TEXT,
    "copiedToMonth" TEXT,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "offer_tiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "offer_tiles_clientId_deletedAt_validFrom_validTo_idx" ON "offer_tiles"("clientId", "deletedAt", "validFrom", "validTo");

-- CreateIndex
CREATE INDEX "offer_tiles_clientId_copiedFromId_copiedToMonth_idx" ON "offer_tiles"("clientId", "copiedFromId", "copiedToMonth");
