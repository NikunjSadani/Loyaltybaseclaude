-- Per-outlet payout-detail MANDATE (UPI vs BANK vs ANY), set at outlet master-upload.
--
-- Additive, forward-only, zero-downtime: a NOT NULL enum column with a safe DEFAULT 'BANK',
-- so every existing outlet back-fills to BANK (the current de-facto behaviour — Deoleo is
-- bank-only) and nothing changes until the FE/upload/KYC-validation ship. UPI is only ever
-- permissible when the tenant's salesApp.upiEnabled is ON (enforced in the upload validator +
-- KYC submit path, not by this column).

CREATE TYPE "OutletPaymentType" AS ENUM ('BANK', 'UPI', 'ANY');

ALTER TABLE "outlets"
    ADD COLUMN "requiredPaymentType" "OutletPaymentType" NOT NULL DEFAULT 'BANK';
