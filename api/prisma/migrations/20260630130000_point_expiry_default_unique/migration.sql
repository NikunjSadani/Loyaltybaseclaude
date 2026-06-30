-- At most ONE default points-expiry config per tenant (active or inactive).
-- Guarantees resolveExpiresAt()'s active-default read is deterministic and that
-- the settings PUT (find-then-update-or-create) can never create duplicate
-- default rows under a concurrent first-write. Scheme-specific configs
-- (isDefault = false) are unaffected — many per tenant are allowed.
--
-- Partial unique index: the Prisma schema DSL cannot express a partial unique,
-- so this is raw SQL (same pattern as the UAT-hardening constraint migrations).
-- Additive + safe on the empty table; idempotent via IF NOT EXISTS.
CREATE UNIQUE INDEX IF NOT EXISTS "point_expiry_config_clientId_default_uq"
  ON "point_expiry_config" ("clientId")
  WHERE "isDefault" = true;
