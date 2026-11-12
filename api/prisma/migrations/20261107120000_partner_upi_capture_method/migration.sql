-- VPA safeguards: record HOW a partner's UPI ID was captured.
--   upiCaptureMethod: 'QR' (scanned) | 'MANUAL' (typed with confirm-entry). NULL = legacy/unknown.
-- ADDITIVE + nullable, no default → no backfill, every existing row stays NULL (byte-identical reads).
ALTER TABLE "channel_partners" ADD COLUMN "upiCaptureMethod" TEXT;
