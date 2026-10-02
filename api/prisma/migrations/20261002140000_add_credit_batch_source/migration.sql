-- Points Compute Engine — Wave 2 (direct-credit path).
-- Add batch provenance + a per-tenant idempotency key for programmatically-created credit batches.
-- Additive + nullable: ordinary operator uploads leave both columns NULL and are unaffected. Postgres
-- treats NULLs as DISTINCT in a UNIQUE index, so many upload batches with sourceKey = NULL coexist; the
-- uniqueness only bites a repeated compute-run key, which is exactly the double-credit guard we want.

ALTER TABLE "credit_batches" ADD COLUMN "sourceKind" TEXT;
ALTER TABLE "credit_batches" ADD COLUMN "sourceKey" TEXT;

CREATE UNIQUE INDEX "credit_batches_clientId_sourceKey_key" ON "credit_batches"("clientId", "sourceKey");
