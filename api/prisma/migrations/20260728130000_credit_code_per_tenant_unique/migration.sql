-- Visibility-payout hardening — credit batch/download codes are per-tenant-sequential (CB-<period>-NNN /
-- PD-<period>-NNN, built from a per-clientId count), so their uniqueness must be scoped PER TENANT, not
-- global. A global UNIQUE collides the moment a 2nd tenant reuses the same code string (e.g. two tenants
-- each create PD-2026-07-001). This swaps each global unique for a composite (clientId, code) unique.
--
-- ADDITIVE-SAFE: existing rows are globally unique, so every (clientId, code) pair is trivially unique too
-- → the composite indexes build without conflict on live data. No data is moved or dropped. The service
-- also generates each code under a per-(clientId, period) pg_advisory_xact_lock so concurrent same-tenant
-- creates serialize into sequential codes rather than racing the composite unique.

-- DropIndex
DROP INDEX "credit_batches_batchCode_key";

-- DropIndex
DROP INDEX "credit_payout_downloads_downloadCode_key";

-- CreateIndex
CREATE UNIQUE INDEX "credit_batches_clientId_batchCode_key" ON "credit_batches"("clientId", "batchCode");

-- CreateIndex
CREATE UNIQUE INDEX "credit_payout_downloads_clientId_downloadCode_key" ON "credit_payout_downloads"("clientId", "downloadCode");
