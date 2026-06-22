-- KPI single-primary invariant: AT MOST ONE primary KPI per tenant (clientId).
--
-- Prisma cannot model PARTIAL unique indexes, so this lives in the migration only.
-- The application enforces "move, not add": targets.service.ts upsertKpi/setPrimary
-- demote every other primary for the tenant in the SAME $transaction before writing,
-- so the normal single-actor flow never trips this index. The index is the race-safe
-- backstop (two concurrent "set primary" calls): the loser's write throws P2002, which
-- the service maps to HTTP 409. The predicate is partial (WHERE "isPrimary"), so 0 or 1
-- primaries are allowed (a fresh tenant before Seed Defaults has 0) — exactly "at most one".
--
-- SELF-HEALING: before creating the index, demote any historical duplicate primaries so the
-- index never aborts an auto-deploy on staging/prod regardless of existing data. Per tenant,
-- keep the primary with the lowest ("order","code") — the SAME tiebreak the app's [order,code]
-- queries use to pick "the" primary — and demote the rest. (No-op on a clean tenant.)
UPDATE "kpi_defs" SET "isPrimary" = false
WHERE "isPrimary" = true
  AND "id" NOT IN (
    SELECT DISTINCT ON ("clientId") "id"
    FROM "kpi_defs"
    WHERE "isPrimary" = true
    ORDER BY "clientId", "order" ASC, "code" ASC
  );

CREATE UNIQUE INDEX "kpi_defs_one_primary_per_client"
  ON "kpi_defs" ("clientId")
  WHERE "isPrimary";
