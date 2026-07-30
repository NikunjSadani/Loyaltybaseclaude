-- Scheme enrollment soft-delete (admin "delete a filled enrollment", recoverable).
-- Additive + nullable: existing rows default to NULL (live). The 1:1 on schemeOutletId is
-- unchanged — re-enrolling the outlet resets the same row (clears deletedAt + appends a
-- new version), so the row is freed to re-enroll while the submission history is retained.
ALTER TABLE "scheme_enrollments" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "scheme_enrollments_deletedAt_idx" ON "scheme_enrollments"("deletedAt");
