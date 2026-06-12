-- AlterEnum: Add REDEMPTION_CONFIRM to OtpPurpose
-- This value is used by the rewards redemption OTP confirmation flow.
-- PostgreSQL ADD VALUE is safe and does not lock existing rows.
ALTER TYPE "OtpPurpose" ADD VALUE IF NOT EXISTS 'REDEMPTION_CONFIRM';
