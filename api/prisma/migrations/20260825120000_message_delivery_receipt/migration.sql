-- Delivery-Status Reporting (Wave 0) — schema foundation. STRICTLY ADDITIVE:
--   * 1 new enum (MessageDeliveryStatus)
--   * 1 new table (message_delivery_receipts) — per-message delivery tracking for transactional
--     SMS + transactional WhatsApp (NOT OTP; OTP uses the light columns added to otp_codes below)
--   * 3 nullable columns on otp_codes (light D1 OTP delivery tracking)
-- NO drops, NO renames, NO repoints, NO backfill. Every existing row stays valid: the new
-- otp_codes columns default to NULL; no existing column or default is touched. Ships dormant
-- (no writer until later waves). See platform/docs/plans/DELIVERY-STATUS-REPORTING-SCOPE.md.

-- ── New enum ─────────────────────────────────────────────────────────────────────────
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- ── message_delivery_receipts — one row per transactional SMS / WhatsApp message ───────
-- crqid IS the client-reference id echoed back by MSG91 on the DLR/outbound-report webhook
-- (the correlation key); msg91RequestId is captured from the send response for the poll fallback.
CREATE TABLE "message_delivery_receipts" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "eventKey" TEXT,
    "recipientPhone" TEXT,
    "crqid" TEXT NOT NULL,
    "msg91RequestId" TEXT,
    "status" "MessageDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "providerResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "message_delivery_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "message_delivery_receipts_crqid_key" ON "message_delivery_receipts"("crqid");
CREATE INDEX "message_delivery_receipts_clientId_channel_createdAt_idx" ON "message_delivery_receipts"("clientId", "channel", "createdAt");
CREATE INDEX "message_delivery_receipts_msg91RequestId_idx" ON "message_delivery_receipts"("msg91RequestId");

-- ── otp_codes — additive nullable columns (light D1 OTP delivery tracking) ─────────────
ALTER TABLE "otp_codes" ADD COLUMN "msg91RequestId" TEXT;
ALTER TABLE "otp_codes" ADD COLUMN "deliveryStatus" "MessageDeliveryStatus";
ALTER TABLE "otp_codes" ADD COLUMN "deliveredAt" TIMESTAMP(3);
