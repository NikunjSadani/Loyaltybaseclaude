-- KYC "shop board name vs address proof name do not match" audit flag.
--
-- Additive, forward-only, zero-downtime: a single NOT NULL column with a safe
-- DEFAULT false, so every existing submission back-fills to false (no mismatch
-- declared) and nothing reads it until the FE ships. Deoleo zero-impact — the
-- runtime behaviour only changes for a tenant whose `clients.features.kycAddressProofWaiver`
-- flag is on AND whose rep ticks the box; the column itself is inert otherwise.

ALTER TABLE "kyc_submissions"
    ADD COLUMN "addressNameMismatch" BOOLEAN NOT NULL DEFAULT false;
