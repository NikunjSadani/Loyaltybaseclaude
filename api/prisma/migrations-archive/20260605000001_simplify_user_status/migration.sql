-- Simplify UserStatus enum: ACTIVE | INACTIVE | PENDING
--
-- Before: ACTIVE, INACTIVE, SUSPENDED, PENDING_VERIFICATION
-- After:  ACTIVE, INACTIVE, PENDING
--
-- Data migration:
--   SUSPENDED          → INACTIVE  (same block-login behaviour, no wrongdoing implied)
--   PENDING_VERIFICATION → PENDING (renamed for clarity)
--
-- PostgreSQL does not support DROP VALUE on an enum directly.
-- Approach: migrate data → create replacement type → swap column → drop old type.

-- Step 1: Add PENDING to the existing enum (safe even if already present via prior migration)
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'PENDING';

-- Step 2: Migrate existing rows before we drop the old values
UPDATE "users" SET status = 'PENDING'   WHERE status = 'PENDING_VERIFICATION';
UPDATE "users" SET status = 'INACTIVE'  WHERE status = 'SUSPENDED';

-- Step 3: Replace enum type (PostgreSQL has no DROP VALUE; must recreate)
-- Guard: drop partial type left by any previously failed attempt
DROP TYPE IF EXISTS "UserStatus_new";
CREATE TYPE "UserStatus_new" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING');

-- Step 4a: Drop default before type change (PostgreSQL cannot auto-cast it)
ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT;

-- Step 4b: Swap column to new type
ALTER TABLE "users"
  ALTER COLUMN "status" TYPE "UserStatus_new"
  USING status::text::"UserStatus_new";

-- Step 5: Drop old type, rename new one into place
DROP TYPE "UserStatus";
ALTER TYPE "UserStatus_new" RENAME TO "UserStatus";

-- Step 6: Restore default with new type
ALTER TABLE "users"
  ALTER COLUMN "status" SET DEFAULT 'PENDING'::"UserStatus";
