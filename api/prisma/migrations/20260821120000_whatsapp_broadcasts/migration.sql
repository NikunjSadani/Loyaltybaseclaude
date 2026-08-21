-- WhatsApp Broadcasts module (Gifsy-operator only) — ADDITIVE, no drops, no backfill.
-- Three new tables + six enums. NO changes to existing tables.
-- See platform/docs/plans/WHATSAPP-BROADCASTS-DESIGN.md.

-- Enums
CREATE TYPE "WhatsappTemplateCategory" AS ENUM ('MARKETING', 'UTILITY', 'AUTHENTICATION');
CREATE TYPE "WhatsappTemplateStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "WhatsappBroadcastAudienceMode" AS ENUM ('FILTER', 'EXCEL');
CREATE TYPE "WhatsappBroadcastScope" AS ENUM ('OUTLETS', 'SALES', 'BOTH');
CREATE TYPE "WhatsappBroadcastStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED');
CREATE TYPE "WhatsappRecipientStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED');

-- whatsapp_templates — per-tenant template library
CREATE TABLE "whatsapp_templates" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "msg91TemplateName" TEXT NOT NULL,
    "category" "WhatsappTemplateCategory" NOT NULL DEFAULT 'UTILITY',
    "languageCode" TEXT NOT NULL DEFAULT 'en',
    "bodyText" TEXT NOT NULL,
    "variableContract" JSONB,
    "headerType" TEXT,
    "footer" TEXT,
    "status" "WhatsappTemplateStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "whatsapp_templates_clientId_name_key" ON "whatsapp_templates"("clientId", "name");
CREATE INDEX "whatsapp_templates_clientId_status_idx" ON "whatsapp_templates"("clientId", "status");

-- whatsapp_broadcasts — a campaign
CREATE TABLE "whatsapp_broadcasts" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "audienceMode" "WhatsappBroadcastAudienceMode" NOT NULL,
    "audienceScope" "WhatsappBroadcastScope",
    "audienceConfig" JSONB,
    "status" "WhatsappBroadcastStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    CONSTRAINT "whatsapp_broadcasts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "whatsapp_broadcasts_clientId_status_idx" ON "whatsapp_broadcasts"("clientId", "status");
CREATE INDEX "whatsapp_broadcasts_status_scheduledAt_idx" ON "whatsapp_broadcasts"("status", "scheduledAt");

-- whatsapp_broadcast_recipients — one row per message (id IS the crqid)
CREATE TABLE "whatsapp_broadcast_recipients" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "variables" JSONB,
    "status" "WhatsappRecipientStatus" NOT NULL DEFAULT 'QUEUED',
    "msg91RequestId" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "errorReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "whatsapp_broadcast_recipients_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "whatsapp_broadcast_recipients_broadcastId_status_idx" ON "whatsapp_broadcast_recipients"("broadcastId", "status");
CREATE INDEX "whatsapp_broadcast_recipients_clientId_status_idx" ON "whatsapp_broadcast_recipients"("clientId", "status");
CREATE INDEX "whatsapp_broadcast_recipients_msg91RequestId_idx" ON "whatsapp_broadcast_recipients"("msg91RequestId");

-- Foreign keys (all between NEW tables — no existing table is touched)
ALTER TABLE "whatsapp_broadcasts" ADD CONSTRAINT "whatsapp_broadcasts_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "whatsapp_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "whatsapp_broadcast_recipients" ADD CONSTRAINT "whatsapp_broadcast_recipients_broadcastId_fkey"
    FOREIGN KEY ("broadcastId") REFERENCES "whatsapp_broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
