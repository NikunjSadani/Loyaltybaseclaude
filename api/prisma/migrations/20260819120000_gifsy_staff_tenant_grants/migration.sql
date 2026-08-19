-- RBAC Option-X (P5) — per-staff tenant-grant table (the TENANT axis of staff access).
-- Additive + dormant: no rows until the owner grants a GIFSY_STAFF access to a brand.
-- clientId is a bare tenant slug (= Client.id), no FK to Client (matches the clientId
-- convention on every other model); FK to users is CASCADE so deleting a staff drops grants.

CREATE TABLE "gifsy_staff_tenant_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gifsy_staff_tenant_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gifsy_staff_tenant_grants_userId_clientId_key" ON "gifsy_staff_tenant_grants"("userId", "clientId");

CREATE INDEX "gifsy_staff_tenant_grants_userId_idx" ON "gifsy_staff_tenant_grants"("userId");

CREATE INDEX "gifsy_staff_tenant_grants_clientId_idx" ON "gifsy_staff_tenant_grants"("clientId");

ALTER TABLE "gifsy_staff_tenant_grants" ADD CONSTRAINT "gifsy_staff_tenant_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
