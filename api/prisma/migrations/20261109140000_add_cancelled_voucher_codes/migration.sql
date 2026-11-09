-- Cancelled voucher codes (tenant-wide reuse guard for "Voucher cancelled with vendor").
-- ADDITIVE ONLY: 1 new table + 2 indexes. No existing table touched -> every tenant byte-identical.
-- Stores sha256 of the normalised code (never the code). See api/src/rewards/voucher-write-guard.ts.

-- CreateTable
CREATE TABLE "cancelled_voucher_codes" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancelled_voucher_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cancelled_voucher_codes_clientId_codeHash_key" ON "cancelled_voucher_codes"("clientId", "codeHash");

-- CreateIndex
CREATE INDEX "cancelled_voucher_codes_orderId_idx" ON "cancelled_voucher_codes"("orderId");
