-- Recording rejected/failed payouts: capture the bank/vendor reason + the uploaded failure date
-- on a non-success CreditPayoutEntry. Both columns are nullable (additive, zero backfill) so the
-- change is byte-identical for existing tenants (incl. live Deoleo).
ALTER TABLE "credit_payout_entries" ADD COLUMN "failureReason" TEXT, ADD COLUMN "attemptedAt" TIMESTAMP(3);
