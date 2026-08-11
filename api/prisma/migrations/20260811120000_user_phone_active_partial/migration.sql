-- Only ACTIVE users reserve (clientId, phone). Prisma @@unique can't express a partial
-- predicate, so this is raw SQL (same pattern as 20260723120000_partner_group_uniqueness).
DROP INDEX IF EXISTS "users_clientId_phone_key";
CREATE UNIQUE INDEX IF NOT EXISTS "users_clientId_phone_active_key"
  ON "users" ("clientId", "phone")
  WHERE "status" = 'ACTIVE';
