-- Employee Rewards Phase C (ADMIN-DESIGN §5.3) — first-class CONTESTS. STRICTLY ADDITIVE:
-- two new tables + one new enum; no existing table/column is touched, so the money-audited
-- trade + employee credit paths are byte-unchanged. A contest bonus is credited MANUALLY via
-- the audited account-first primitive (WalletService.creditEarnForAccount), NOT through the
-- EMPLOYEE_UPLOAD credit-batch rail — so it coexists with the monthly points batch (the F2
-- one-confirmed-batch-per-period guard never applies). Dormant until an admin creates a contest.

-- CreateEnum
CREATE TYPE "ContestStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CREDITED', 'CANCELLED');

-- CreateTable
CREATE TABLE "contests" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "bannerUrl" TEXT,
    "description" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "eligibleRoleCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "eligibleRegions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bonusPoints" INTEGER NOT NULL DEFAULT 0,
    "status" "ContestStatus" NOT NULL DEFAULT 'DRAFT',
    "bonusCreditedAt" TIMESTAMP(3),
    "bonusCreditedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contest_bonus_credits" (
    "id" TEXT NOT NULL,
    "contestId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "creditedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contest_bonus_credits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contests_clientId_status_idx" ON "contests"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contest_bonus_credits_contestId_employeeCode_key" ON "contest_bonus_credits"("contestId", "employeeCode");

-- CreateIndex
CREATE INDEX "contest_bonus_credits_contestId_idx" ON "contest_bonus_credits"("contestId");

-- CreateIndex
CREATE INDEX "contest_bonus_credits_clientId_idx" ON "contest_bonus_credits"("clientId");

-- AddForeignKey
ALTER TABLE "contest_bonus_credits" ADD CONSTRAINT "contest_bonus_credits_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "contests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
