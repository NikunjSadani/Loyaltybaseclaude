-- CreateTable
CREATE TABLE "partner_wishlists" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "rewardId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_wishlists_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "partner_wishlists_clientId_partnerId_idx" ON "partner_wishlists"("clientId", "partnerId");

-- CreateIndex
CREATE INDEX "partner_wishlists_rewardId_idx" ON "partner_wishlists"("rewardId");

-- CreateIndex
CREATE UNIQUE INDEX "partner_wishlists_partnerId_rewardId_key" ON "partner_wishlists"("partnerId", "rewardId");

-- AddForeignKey
ALTER TABLE "partner_wishlists" ADD CONSTRAINT "partner_wishlists_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "partner_wishlists" ADD CONSTRAINT "partner_wishlists_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "reward_catalog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
