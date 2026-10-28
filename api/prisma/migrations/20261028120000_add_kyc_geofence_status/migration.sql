-- Outlet-master geo-fence status for KYC enrollment (Bajaj-only via clients.features.outletMasterGeo).
-- Additive, nullable → no backfill; every non-gated tenant (incl. live Deoleo) keeps NULL → byte-identical.
--   geoFenceStatus    : 'OK' | 'UNVERIFIABLE' (NULL for non-gated tenants)
--   geoFenceDistanceM : rounded metres from the outlet master (NULL when unverifiable / non-gated)
--   geoFenceAccuracyM : board-photo fix accuracy, rounded metres (UAT benchmarking; NULL for non-gated)
--   geoLockMs         : ms the FE spent acquiring the board-photo fix (UAT benchmarking; NULL for non-gated)
ALTER TABLE "kyc_submissions"
  ADD COLUMN "geoFenceStatus" TEXT,
  ADD COLUMN "geoFenceDistanceM" INTEGER,
  ADD COLUMN "geoFenceAccuracyM" INTEGER,
  ADD COLUMN "geoLockMs" INTEGER;
