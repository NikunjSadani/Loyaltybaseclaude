-- VISIBILITY-PER-PHOTO-APPROVAL (additive, no data reset).
-- Per-CAMERA-field review state on the live capture row + a per-version snapshot on the
-- immutable submission history. Both nullable → every existing row (incl. dormant Deoleo)
-- stays byte-identical; the feature is inert until a multi-photo review is performed.
ALTER TABLE "visibility_captures"
  ADD COLUMN "photoReviews" JSONB;

ALTER TABLE "visibility_capture_submissions"
  ADD COLUMN "photoReviews" JSONB;
