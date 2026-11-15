-- Interim PAYOUT-reversal rule (WALLET-REVERSAL-ENGINE-DESIGN.md Q9/Q14): a payout reversal
-- consumes WHOLE payout entries and records which ones, so no later reversal can consume the
-- same entry again (a PAID entry stays PAID after its receivable is recorded).
-- Additive: one nullable column, no backfill (NULL = approved before this column existed; the
-- service infers those from approvedAt), no data change.
ALTER TABLE "credit_reversals" ADD COLUMN "consumedPayoutEntryIds" JSONB;
