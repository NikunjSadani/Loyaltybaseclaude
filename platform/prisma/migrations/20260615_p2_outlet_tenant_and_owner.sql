-- P2 / 2.4 migration (dev DB only — gifsy_dev).
-- Supports "create the outlet before its owner" + two multi-tenant uniqueness fixes.
--   * Outlet gains its own `clientId` (an ownerless outlet can't derive tenant from a null partner).
--   * Outlet.partnerId becomes nullable; the partner FK becomes ON DELETE SET NULL
--     (deleting an owner orphans, not deletes, the shop).
--   * RF5: outletCode uniqueness moves from GLOBAL to per-tenant (clientId, outletCode).
--   * RF7: SalesUser gains `clientId`; employeeCode uniqueness moves from GLOBAL to
--     per-tenant (clientId, employeeCode).
-- Generated read-only via `prisma migrate diff` (HEAD schema -> edited schema).
-- SAFE: outlets / sales_users / channel_partners are EMPTY (verified 0 rows), so the
-- NOT NULL column adds cannot fail and no backfill is required.

BEGIN;

DO $$
BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'Refusing to run P2 2.4 migration: expected database gifsy_dev, got %', current_database();
  END IF;
END $$;

-- DropForeignKey (re-added below as SET NULL)
ALTER TABLE "outlets" DROP CONSTRAINT "outlets_partnerId_fkey";

-- DropIndex (old global uniques)
DROP INDEX "sales_users_employeeCode_key";
DROP INDEX "outlets_outletCode_key";

-- AlterTable
ALTER TABLE "sales_users" ADD COLUMN     "clientId" TEXT NOT NULL;
ALTER TABLE "outlets" ADD COLUMN     "clientId" TEXT NOT NULL,
ALTER COLUMN "partnerId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "sales_users_clientId_idx" ON "sales_users"("clientId");
CREATE UNIQUE INDEX "sales_users_clientId_employeeCode_key" ON "sales_users"("clientId", "employeeCode");
CREATE INDEX "outlets_clientId_idx" ON "outlets"("clientId");
CREATE UNIQUE INDEX "outlets_clientId_outletCode_key" ON "outlets"("clientId", "outletCode");

-- AddForeignKey (now nullable, SET NULL on owner delete)
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "channel_partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
