-- Capture bank/UPI payout details at redemption (additive; default VERIFIED keeps every existing
-- row + all of Deoleo byte-identical). See platform/docs/plans/PAYMENT-DETAILS-AT-REDEMPTION-DESIGN.md.

-- 1. Trust state of a partner's bank/UPI payout details.
CREATE TYPE "PaymentDetailsStatus" AS ENUM ('VERIFIED', 'UNVERIFIED', 'NEEDS_RECAPTURE');

-- 2. New columns on channel_partners.
--    paymentDetailsStatus: NOT NULL DEFAULT 'VERIFIED' → Postgres backfills every existing row to
--      VERIFIED, so all current Store-Info displays (incl. Deoleo) are unchanged. Only the new
--      redemption self-capture path writes UNVERIFIED; the KYC submit path never writes UNVERIFIED.
--    bankVerifiedAt: stamped when a redemption payout on these details is marked PAID (NULL otherwise).
--    payoutChequeFileKey: the redemption-captured cancelled cheque (GCS key kyc/<clientId>/…; NULL otherwise).
ALTER TABLE "channel_partners"
  ADD COLUMN "paymentDetailsStatus" "PaymentDetailsStatus" NOT NULL DEFAULT 'VERIFIED',
  ADD COLUMN "bankVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "payoutChequeFileKey" TEXT;
