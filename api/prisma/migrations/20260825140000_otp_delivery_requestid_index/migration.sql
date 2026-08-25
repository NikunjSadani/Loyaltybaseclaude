-- Delivery-Status Reporting (Wave 3) — OTP delivery correlation index. STRICTLY ADDITIVE.
-- The light D1 OTP delivery-report ingestion correlates an OtpCode by its captured msg91RequestId
-- (the fallback lookup after MessageDeliveryReceipt misses). Index that nullable, non-unique column
-- for the lookup. NO drops, NO renames, NO backfill. Ships dormant with the rest of Wave 3.
-- See platform/docs/plans/DELIVERY-STATUS-REPORTING-SCOPE.md §6 (D1).
CREATE INDEX "otp_codes_msg91RequestId_idx" ON "otp_codes"("msg91RequestId");
