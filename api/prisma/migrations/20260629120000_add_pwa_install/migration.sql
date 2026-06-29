-- PWA install tracking (adoption analytics): one row per (user, platform) recording
-- that the user launched the app as an INSTALLED PWA (home-screen / standalone), as
-- reported by a client beacon. UPSERT keyed on the unique (userId, platform); userId/
-- clientId are stamped from the JWT (never the request body). Distinct from
-- push_subscription (notifications enabled) — install and subscribe are independent.
--
-- Additive: a brand-new table with a single FK to users (ON DELETE CASCADE), no change
-- to any existing table, so this is safe to apply with no backfill.

-- CreateTable
CREATE TABLE "pwa_install" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "userAgent" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pwa_install_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pwa_install_clientId_idx" ON "pwa_install"("clientId");

-- CreateIndex
CREATE INDEX "pwa_install_userId_idx" ON "pwa_install"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "pwa_install_userId_platform_key" ON "pwa_install"("userId", "platform");

-- AddForeignKey
ALTER TABLE "pwa_install" ADD CONSTRAINT "pwa_install_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
