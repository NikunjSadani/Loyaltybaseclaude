-- Gift-card PIN for card+PIN products (Hubble CARD_AND_PIN_NO_SECURED, or a manual card+PIN voucher).
-- ADDITIVE ONLY: one nullable column. Existing rows stay NULL -> every tenant byte-identical.
-- AlterTable
ALTER TABLE "redemption_orders" ADD COLUMN "voucherPin" TEXT;
