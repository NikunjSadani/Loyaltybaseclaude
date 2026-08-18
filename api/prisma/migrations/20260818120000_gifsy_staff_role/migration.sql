-- RBAC Option-X: add the GIFSY_STAFF operator role (below the GIFSY_ADMIN owner tier).
-- Additive enum value; a GIFSY_STAFF user has NO permissions by default — access comes from
-- the assigned GifsyRole (users.gifsyRoleId). Separate migration so ADD VALUE is not mixed
-- with other DDL (mirrors 20260814120000_kyc_field_source_group_inherited).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'GIFSY_STAFF';
