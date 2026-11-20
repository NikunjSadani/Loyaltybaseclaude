-- Help & videos (Bajaj, 2026-11-20). ADDITIVE ONLY: 1 new enum type + 1 new table + 1 index.
-- No existing table is touched -> every tenant (incl. Deoleo) byte-identical. Idempotent (guarded enum,
-- IF NOT EXISTS table/index), so a re-run after a partial apply is safe. See platform/docs/plans/HELP-VIDEOS.md.
SET lock_timeout = '5s';

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "HelpTopicAudience" AS ENUM ('SALES', 'PARTNER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "help_topics" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "audience" "HelpTopicAudience" NOT NULL,
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "videoKey" TEXT,
    "videoBytes" INTEGER,
    "posterKey" TEXT,
    "steps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "help_topics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "help_topics_clientId_audience_deletedAt_sortOrder_idx" ON "help_topics"("clientId", "audience", "deletedAt", "sortOrder");

RESET lock_timeout;
