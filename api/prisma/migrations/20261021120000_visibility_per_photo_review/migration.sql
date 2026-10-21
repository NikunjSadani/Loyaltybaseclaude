-- VISIBILITY-PER-PHOTO-APPROVAL (additive, no data reset).
-- New whole-capture state for per-photo review: some required photo(s) rejected →
-- the rep must re-capture only the rejected photo(s). The window is NOT satisfied
-- (only APPROVED satisfies it). REJECTED stays the explicit whole-capture reject.
--
-- Postgres cannot ADD VALUE inside a transaction block that also USES the new label, so
-- this is a lone statement (Prisma does not wrap a lone ALTER TYPE ... ADD VALUE in a tx).
-- The new label is only referenced by later migrations / runtime, never in this file.
ALTER TYPE "VisibilityCaptureStatus" ADD VALUE IF NOT EXISTS 'CHANGES_REQUESTED';
