-- Sales Import month history hardening (final independent check). Touches only the unreleased sales-import tables.

-- H1/M1: one small HEADER row per (tenant, month) history set: which import it holds, when it was applied, and the
-- column mapping (fingerprint + dimension keys) its lines were parsed with. Month lists read this table (never the
-- line rows), and recalculate checks the current KPIs' dimensions against `dimensionKeys`.
CREATE TABLE "sales_month_history_sets" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "sourceImportId" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL,
    "appliedById" TEXT NOT NULL,
    "mappingFingerprint" TEXT,
    "dimensionKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lineRows" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sales_month_history_sets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sales_month_history_sets_clientId_month_key" ON "sales_month_history_sets"("clientId", "month");

-- Backfill headers for history written before this migration (dev / verification databases only).
INSERT INTO "sales_month_history_sets"
  ("id", "clientId", "month", "sourceImportId", "appliedAt", "appliedById", "mappingFingerprint", "dimensionKeys", "lineRows")
SELECT md5(h."clientId" || '|' || h."month"), h."clientId", h."month", h."sourceImportId", h."appliedAt", h."appliedById",
       i."mappingFingerprint",
       ARRAY(SELECT d->>'key' FROM jsonb_array_elements(COALESCE(i."mappingSnapshot"->'dimensions', '[]'::jsonb)) AS d),
       h.n
  FROM (
    SELECT DISTINCT ON ("clientId", "month") "clientId", "month", "sourceImportId", "appliedAt", "appliedById",
           count(*) OVER (PARTITION BY "clientId", "month")::int AS n
      FROM "sales_month_histories"
     ORDER BY "clientId", "month", "id"
  ) h
  LEFT JOIN "sales_imports" i ON i."id" = h."sourceImportId";

-- L1: the line-row uniqueness uses a fixed-size hash of (customerCode, dimKey) instead of the raw text, which could
-- exceed Postgres' index row size for long dimension values.
ALTER TABLE "sales_month_histories" ADD COLUMN "keyHash" TEXT;
UPDATE "sales_month_histories" SET "keyHash" = md5("customerCode" || chr(31) || "dimKey");
ALTER TABLE "sales_month_histories" ALTER COLUMN "keyHash" SET NOT NULL;
DROP INDEX "sales_month_histories_clientId_month_customerCode_dimKey_key";
CREATE UNIQUE INDEX "sales_month_histories_clientId_month_keyHash_key" ON "sales_month_histories"("clientId", "month", "keyHash");
