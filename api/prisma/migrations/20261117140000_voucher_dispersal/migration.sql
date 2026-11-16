-- Voucher Dispersal (platform/docs/plans/VOUCHER-DISPERSAL.md): platform-level Gifsy admin tool that buys one Hubble
-- voucher per uploaded row and sends it by WhatsApp. ADDITIVE ONLY: two new enums + two new tables; no existing table touched.

-- CreateEnum
CREATE TYPE "VoucherDispersalCampaignStatus" AS ENUM ('DRAFT', 'PREVIEWED', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VoucherDispersalRowStatus" AS ENUM ('VALID', 'INVALID', 'DUPLICATE', 'QUEUED', 'BUYING', 'PENDING_RECONCILE', 'BOUGHT', 'BUY_FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "voucher_dispersal_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "programLabel" TEXT NOT NULL,
    "billedToClientId" TEXT,
    "note" TEXT,
    "budgetPaise" BIGINT NOT NULL,
    "status" "VoucherDispersalCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "sourceFileName" TEXT,
    "previewId" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "uploadedById" TEXT,
    "createdById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voucher_dispersal_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_dispersal_rows" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "phone" TEXT,
    "rawPhone" TEXT,
    "dedupePhone" TEXT,
    "name" TEXT NOT NULL,
    "amountPaise" BIGINT,
    "brandKey" TEXT,
    "brandLabel" TEXT,
    "productId" TEXT,
    "note" TEXT,
    "status" "VoucherDispersalRowStatus" NOT NULL,
    "invalidReason" TEXT,
    "warning" TEXT,
    "hubbleReferenceId" TEXT,
    "previousReferenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hubbleAccount" TEXT,
    "hubbleOrderId" TEXT,
    "placeAttemptAt" TIMESTAMP(3),
    "referenceSentAt" TIMESTAMP(3),
    "placeResponded" BOOLEAN,
    "claimToken" TEXT,
    "buyingAt" TIMESTAMP(3),
    "pendingReason" TEXT,
    "pendingSince" TIMESTAMP(3),
    "lastReconcileAt" TIMESTAMP(3),
    "lastReconcileResult" TEXT,
    "voucherCode" TEXT,
    "voucherPin" TEXT,
    "voucherValidTill" TEXT,
    "boughtAt" TIMESTAMP(3),
    "buyFailureReason" TEXT,
    "buyFailureSource" TEXT,
    "whatsappReceiptId" TEXT,
    "messageClaimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "messageError" TEXT,
    "messageStatus" TEXT,
    "messageDeliveredAt" TIMESTAMP(3),
    "messageReadAt" TIMESTAMP(3),
    "messageFailureReason" TEXT,
    "resendCount" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voucher_dispersal_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "voucher_dispersal_campaigns_status_createdAt_idx" ON "voucher_dispersal_campaigns"("status", "createdAt");

-- CreateIndex
CREATE INDEX "voucher_dispersal_campaigns_billedToClientId_createdAt_idx" ON "voucher_dispersal_campaigns"("billedToClientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_dispersal_rows_hubbleReferenceId_key" ON "voucher_dispersal_rows"("hubbleReferenceId");

-- CreateIndex
CREATE INDEX "voucher_dispersal_rows_campaignId_status_idx" ON "voucher_dispersal_rows"("campaignId", "status");

-- CreateIndex
CREATE INDEX "voucher_dispersal_rows_status_updatedAt_idx" ON "voucher_dispersal_rows"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_dispersal_rows_campaignId_rowNumber_key" ON "voucher_dispersal_rows"("campaignId", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_dispersal_rows_campaignId_dedupePhone_key" ON "voucher_dispersal_rows"("campaignId", "dedupePhone");

-- AddForeignKey
ALTER TABLE "voucher_dispersal_rows" ADD CONSTRAINT "voucher_dispersal_rows_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "voucher_dispersal_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

