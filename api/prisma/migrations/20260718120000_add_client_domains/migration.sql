-- §A-DOMAIN — DB-driven tenant domain → slug routing.
--
-- Additive, forward-only, zero-downtime: nothing reads this table until the
-- Phase-2 resolver ships. Backfills each tenant's current domain(s) from the
-- code registry (CLIENT_REGISTRY) so the DB is a faithful copy before any
-- resolver switch. Deoleo zero-impact — its slug/clientId `deoleo` never changes;
-- only where the `deoleoloyalty.gifsy.in → deoleo` mapping is READ from moves.

-- 1. The table (join-table shape; matches the no-array-column house style).
CREATE TABLE "client_domains" (
    "id"        TEXT NOT NULL,
    "clientId"  TEXT NOT NULL,
    "domain"    TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_domains_pkey" PRIMARY KEY ("id")
);

-- 2. Global, case-insensitive uniqueness — a domain maps to exactly ONE tenant
--    platform-wide. Expression index (Prisma can't model LOWER()), per MIGRATIONS.md.
CREATE UNIQUE INDEX "client_domains_domain_lower_key" ON "client_domains" (LOWER("domain"));

-- 3. Reverse/forward lookup by tenant.
CREATE INDEX "client_domains_clientId_idx" ON "client_domains" ("clientId");

-- 4. Backfill: Deoleo's branded domain (exactly CLIENT_REGISTRY.deoleo.domains today) → primary.
INSERT INTO "client_domains" ("id", "clientId", "domain", "isPrimary", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'deoleo', 'deoleoloyalty.gifsy.in', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE EXISTS (SELECT 1 FROM "clients" WHERE "id" = 'deoleo')
  AND NOT EXISTS (SELECT 1 FROM "client_domains" WHERE LOWER("domain") = 'deoleoloyalty.gifsy.in');

-- 5. Backfill: every tenant's canonical <slug>.gifsy.in subdomain (completes the DB map so the
--    subdomain heuristic can be retired). Primary only if the tenant has no primary yet.
INSERT INTO "client_domains" ("id", "clientId", "domain", "isPrimary", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, c."id", c."id" || '.gifsy.in',
       NOT EXISTS (SELECT 1 FROM "client_domains" d2 WHERE d2."clientId" = c."id" AND d2."isPrimary"),
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "clients" c
WHERE NOT EXISTS (
  SELECT 1 FROM "client_domains" d WHERE LOWER(d."domain") = LOWER(c."id" || '.gifsy.in')
);
