-- Bind an OTP to a specific entity (order-scoped REDEMPTION_CONFIRM).
--
-- Additive, forward-only, zero-downtime: a single NULLABLE column + an index. Existing rows
-- back-fill to NULL (no scope), and the only reader (verifyRedemptionOtp) filters on it only for
-- REDEMPTION_CONFIRM, which now always sets it. A login can hold concurrent PENDING redemption
-- orders across outlets (login picker); scoping the OTP to its order.id stops one order's confirm
-- from consuming another order's OTP. Inert for every other OTP purpose.

ALTER TABLE "otp_codes"
    ADD COLUMN "referenceId" TEXT;

CREATE INDEX "otp_codes_referenceId_idx" ON "otp_codes"("referenceId");
