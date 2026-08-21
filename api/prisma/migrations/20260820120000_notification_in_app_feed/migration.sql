-- In-app notification "bell feed" (Phase 1) — ADDITIVE, no drops, no backfill.
-- Adds a nullable readAt (unread = NULL) to the kept queue model so an IN_APP row
-- can be marked read, plus two composite indexes that back the feed's hot paths:
--   * paging a user's feed newest-first        (userId, channel, createdAt)
--   * unread-count / read-all lookups           (userId, channel, readAt)
-- Table is "notification_queue" (Prisma @@map of model NotificationQueue). IN_APP
-- rows are written directly as SENT, so the PUSH drainer (channel='PUSH' AND
-- status='QUEUED') never touches them.
ALTER TABLE "notification_queue" ADD COLUMN "readAt" TIMESTAMP(3);

CREATE INDEX "notification_queue_userId_channel_createdAt_idx"
    ON "notification_queue"("userId", "channel", "createdAt");

CREATE INDEX "notification_queue_userId_channel_readAt_idx"
    ON "notification_queue"("userId", "channel", "readAt");
