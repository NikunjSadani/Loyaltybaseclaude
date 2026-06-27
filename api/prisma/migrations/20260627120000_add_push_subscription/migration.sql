-- Web Push (PWA, phase F5): one row per browser/device endpoint a user has granted
-- push permission on. UPSERT keyed on the unique W3C Push `endpoint` URL; userId/clientId
-- are stamped from the JWT (never the request body). The drain worker (DEFAULT OFF via
-- PUSH_WORKER_ENABLED) reads NotificationQueue PUSH rows and the sender posts to each
-- endpoint via VAPID, pruning dead (404/410) subscriptions.
--
-- Additive: a brand-new table with a single FK to users (ON DELETE CASCADE), no change
-- to any existing table, so this is safe to apply at cutover with no backfill.

-- CreateTable
CREATE TABLE "push_subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscription_endpoint_key" ON "push_subscription"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscription_userId_idx" ON "push_subscription"("userId");

-- CreateIndex
CREATE INDEX "push_subscription_clientId_idx" ON "push_subscription"("clientId");

-- AddForeignKey
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
