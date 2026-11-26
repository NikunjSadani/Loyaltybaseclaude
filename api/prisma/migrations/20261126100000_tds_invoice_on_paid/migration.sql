-- 194C TDS INVOICE ONLY ON SUCCESS (owner-approved 2026-11-25, PLATFORM-WIDE incl. Deoleo). Additive + re-runnable.
--  * tds_recovery_entries."raisedOn": 'PAID' for rows raised when the payout is PAID (new timing); NULL = raised at the
--    bank file under the old timing (every existing row — never rewritten).
--  * The one-LIVE-invoice-per-(client, outlet, month, kind) rule becomes SERVICE-only: a 194C TDS top-up invoice is now
--    raised per bank RESULT, and several results can land in one month for the same payee (the yearly-increment maths
--    + the TGSL-TDS-<PAN>-<FY>-<seq> unique number keep it single and never double). The anchor-per-(client, PAN, FY)
--    partial unique on TDS invoices is unchanged.
SET lock_timeout = '5s';

ALTER TABLE "tds_recovery_entries" ADD COLUMN IF NOT EXISTS "raisedOn" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "auto_invoices_live_service_outlet_period_key"
  ON "auto_invoices" ("clientId", "outletCode", "period")
  WHERE "voidedAt" IS NULL AND "invoiceKind" = 'SERVICE';
DROP INDEX IF EXISTS "auto_invoices_live_outlet_period_kind_key";

RESET lock_timeout;
