/**
 * Vendor gift price bounds (Gift Catalogue & Dispatch, review #8) — PURE + DI-free
 * so it is unit-testable without the DI container.
 *
 * A vendor sets its own ₹ selling price, and that price is FROZEN onto the order as
 * `valuePaise` (decision #14) which feeds the receiving OUTLET's 194R base. A
 * mis-priced gift therefore inflates the outlet's tax base — a tax-integrity vector,
 * not merely a commercial one. So the price is bounded SERVER-SIDE on EVERY vendor
 * write (create / edit / bulk upload) INCLUDING under AUTO_LIVE (where no human sees
 * it before it goes live):
 *   - mrpPaise is REQUIRED and must be positive for a vendor item.
 *   - sellingValuePaise must be >= VENDOR_MIN_SELLING_VALUE_PAISE (a hard floor).
 *   - sellingValuePaise must be <= mrpPaise × VENDOR_MAX_PRICE_PCT_OF_MRP / 100
 *     (a gift can't be sold above its MRP — the cap is a % of MRP).
 */

/** Absolute floor for any vendor gift selling value (₹1 = 100 paise). */
export const VENDOR_MIN_SELLING_VALUE_PAISE = 100;

/** Max selling value as a percentage of MRP. 100 = the selling price may not exceed MRP. */
export const VENDOR_MAX_PRICE_PCT_OF_MRP = 100;

export interface VendorPriceInput {
  sellingValuePaise: number | null | undefined;
  mrpPaise: number | null | undefined;
}

export class VendorPriceError extends Error {}

/**
 * Validate a vendor item's price bounds. Throws {@link VendorPriceError} with a
 * user-facing message on any violation; returns void when valid. The caller maps the
 * error to a BadRequestException (kept DI-free here so it can be unit-tested alone).
 */
export function assertVendorPriceBounds(input: VendorPriceInput): void {
  const { sellingValuePaise, mrpPaise } = input;

  if (mrpPaise == null || mrpPaise <= 0) {
    throw new VendorPriceError('MRP (mrpPaise) is required and must be positive for a vendor gift.');
  }
  if (sellingValuePaise == null || sellingValuePaise <= 0) {
    throw new VendorPriceError('Selling value (sellingValuePaise) is required and must be positive.');
  }
  if (sellingValuePaise < VENDOR_MIN_SELLING_VALUE_PAISE) {
    throw new VendorPriceError(
      `Selling value must be at least ₹${VENDOR_MIN_SELLING_VALUE_PAISE / 100}.`,
    );
  }
  const maxPaise = Math.floor((mrpPaise * VENDOR_MAX_PRICE_PCT_OF_MRP) / 100);
  if (sellingValuePaise > maxPaise) {
    throw new VendorPriceError(
      `Selling value cannot exceed ${VENDOR_MAX_PRICE_PCT_OF_MRP}% of MRP (₹${maxPaise / 100}).`,
    );
  }
}
