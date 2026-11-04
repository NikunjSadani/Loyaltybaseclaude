-- FIFO points-expiry fix: track remaining (unspent, unexpired) points per spendable lot.
-- Additive + safe: existing rows default to 0 (immaterial — no live tenant has active expiry;
-- prod has 0 points_ledger rows). New spendable lots get remainingPoints = points in app code.
-- See platform/docs/plans/POINTS-EXPIRY-FIFO-DESIGN.md.
ALTER TABLE "points_ledger" ADD COLUMN "remainingPoints" INTEGER NOT NULL DEFAULT 0;
