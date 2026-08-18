-- RBAC Option-X: custom Gifsy operator roles (self-service) + the staff→role link.
-- `permissions` is a Postgres text[] of Permission keys (api/src/common/rbac/permissions.ts);
-- the guard resolver validates each key via isPermission() and ignores unknowns.
CREATE TABLE "gifsy_roles" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "gifsy_roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gifsy_roles_clientId_name_key" ON "gifsy_roles"("clientId", "name");
CREATE INDEX "gifsy_roles_clientId_idx" ON "gifsy_roles"("clientId");
CREATE INDEX "gifsy_roles_deletedAt_idx" ON "gifsy_roles"("deletedAt");

ALTER TABLE "users" ADD COLUMN "gifsyRoleId" TEXT;
CREATE INDEX "users_gifsyRoleId_idx" ON "users"("gifsyRoleId");
ALTER TABLE "users" ADD CONSTRAINT "users_gifsyRoleId_fkey" FOREIGN KEY ("gifsyRoleId") REFERENCES "gifsy_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
