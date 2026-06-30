-- Daily activity tracking (Session Report's active-days metric): one row per
-- (user, IST-calendar-day) on which the user made >=1 authenticated request.
-- Written fire-and-forget from JwtStrategy.validate with an in-memory once-per-day
-- dedupe; userId/clientId are stamped from the JWT (never the request body). The
-- unique (userId, activityDate) makes concurrent / cross-instance repeats no-ops.
-- DISTINCT from a login: a 7-day token means one login spans many active days.
-- `activityDate` is a DATE in Asia/Kolkata, so grouping by its year-month gives IST
-- months directly.
--
-- Additive: a brand-new table with a single FK to users (ON DELETE CASCADE), no
-- change to any existing table, so this is safe to apply with no backfill.

-- CreateTable
CREATE TABLE "user_activity_day" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "activityDate" DATE NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_activity_day_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_activity_day_clientId_activityDate_idx" ON "user_activity_day"("clientId", "activityDate");

-- CreateIndex
CREATE INDEX "user_activity_day_activityDate_idx" ON "user_activity_day"("activityDate");

-- CreateIndex
CREATE UNIQUE INDEX "user_activity_day_userId_activityDate_key" ON "user_activity_day"("userId", "activityDate");

-- AddForeignKey
ALTER TABLE "user_activity_day" ADD CONSTRAINT "user_activity_day_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
