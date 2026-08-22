-- Gift Catalogue & Dispatch (Wave 0) — add the VENDOR operator role.
-- Additive enum value; a VENDOR user's access is hard-scoped via User.vendorId + a
-- VendorTenantGrant (Wave 1+ logic). Separate migration so ADD VALUE is not mixed with
-- other DDL (mirrors 20260818120000_gifsy_staff_role / 20260731170000_outlet_kyc_intent_parked).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'VENDOR';
