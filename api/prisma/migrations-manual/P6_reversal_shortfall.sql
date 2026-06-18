-- ============================================================================
-- P6.2 — Reversal shortfall (reporting only)
-- ============================================================================
-- Records the PENDING portion of an approved POINTS reversal — the points that
-- could NOT be clawed back from the wallet because the partner had already
-- redeemed them. Used purely for the reversal report:
--   supposed  = approvedPaise          (how much was approved to reverse)
--   reversed  = approvedPaise - shortfallPaise  (how much actually came off the wallet)
--   pending   = shortfallPaise          (the client settles this off-platform; platform does nothing)
-- BigInt to match the other money/points columns (POINTS reversals store whole points here).
-- Guarded to gifsy_dev, idempotent, additive (credit_reversals is empty in dev).
-- ============================================================================
DO $$
BEGIN
  IF current_database() <> 'gifsy_dev' THEN
    RAISE EXCEPTION 'Refusing to run: current_database() = % (expected gifsy_dev)', current_database();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='credit_reversals'
                   AND column_name='shortfallPaise') THEN
    ALTER TABLE "credit_reversals" ADD COLUMN "shortfallPaise" BIGINT NOT NULL DEFAULT 0;
  END IF;
END $$;
