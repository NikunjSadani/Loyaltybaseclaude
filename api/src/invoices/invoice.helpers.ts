/**
 * Invoice helpers — pure logic for self-bill visibility invoices (P6.7).
 *
 * Self-billing arrangement: the retailer (outlet) renders visibility services;
 * Gifsy generates the invoice on the retailer's behalf. The bill recipient is
 * Tech Gifsy Solutions Limited (WB, state code 19).
 *
 * TDS is OUT OF SCOPE here (deferred to P6.5). Do NOT compute TDS.
 *
 * GST rule (#15) — paise-based:
 *   - Only REGULAR GST-registered retailers attract GST.
 *   - Intra/inter determination uses retailer GSTIN first 2 digits vs '19' (WB).
 *   - Equal → CGST 9% + SGST 9% (gstType = CGST_SGST)
 *   - Different → IGST 18%          (gstType = IGST)
 *   - Not REGULAR (or no GSTIN)    → no GST (gstType = null, gstPaise = 0)
 *   - Base is GST-EXCLUSIVE. total = base + gst.
 *
 * Money: all amounts in integer paise (BigInt).
 */

// ── Recipient constant (the self-bill buyer) ────────────────────────────────

export const TECH_GIFSY = {
  legalName: 'Tech Gifsy Solutions Limited',
  gstin: '19AAACT9811F1Z9',
  pan: 'AAACT9811F',
  stateCode: '19',
  state: 'West Bengal',
  address: '16, India Exchange Place, Kolkata, West Bengal 700001',
  sacCode: '998361',
} as const;

// ── Types ────────────────────────────────────────────────────────────────────

export type GstType = 'CGST_SGST' | 'IGST';

export interface GstResult {
  gstApplicable: boolean;
  gstType: GstType | null;
  /** Combined GST paise (CGST+SGST or IGST). Stored as gstPaise on AutoInvoice. */
  gstPaise: bigint;
  totalPaise: bigint;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate invoice number.
 * Format: TGSL-VIS-[OUTLET_CODE]-[YYYYMM]-[SEQ]
 * seq is zero-padded to 3 digits.
 *
 * @param outletCode  Outlet code (uppercased automatically)
 * @param period      "YYYY-MM"
 * @param seq         1-based sequence number per (clientId, period)
 */
export function generateInvoiceNumber(
  outletCode: string,
  period: string,
  seq: number,
): string {
  const yyyymm = period.replace('-', '');
  const seqStr = String(seq).padStart(3, '0');
  return `TGSL-VIS-${outletCode.toUpperCase()}-${yyyymm}-${seqStr}`;
}

/**
 * Format a period string "YYYY-MM" → human label "Month YYYY" (en-IN locale).
 *
 * @example formatPeriodLabel('2025-01') → 'January 2025'
 */
export function formatPeriodLabel(period: string): string {
  const [year, month] = period.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
}

/**
 * Build the fixed invoice description for a period.
 *
 * @example buildInvoiceDescription('January 2025') → 'Marketing visibility services — January 2025'
 */
export function buildInvoiceDescription(periodLabel: string): string {
  return `Marketing visibility services — ${periodLabel}`;
}

/**
 * Compute GST on a base paise amount.
 *
 * Determination uses the retailer GSTIN's first 2 digits (state code):
 *   '19' (WB, same as Tech Gifsy) → intra-state (CGST 9% + SGST 9%)
 *   anything else                  → inter-state (IGST 18%)
 *
 * Each component is rounded to the nearest paise before summing.
 *
 * @param basePaise              Pre-GST amount (integer paise)
 * @param gstRegistrationType    From ChannelPartner.gstRegistrationType
 * @param retailerGstin          ChannelPartner.gstNumber (may be null)
 */
export function computeGST(
  basePaise: bigint,
  gstRegistrationType: string | null | undefined,
  retailerGstin: string | null | undefined,
): GstResult {
  // GST only for REGULAR registrants with a GSTIN.
  if (gstRegistrationType !== 'REGULAR' || !retailerGstin) {
    return {
      gstApplicable: false,
      gstType: null,
      gstPaise: 0n,
      totalPaise: basePaise,
    };
  }

  // Intra-state: retailer state code (first 2 digits of GSTIN) === '19' (WB / Tech Gifsy).
  const retailerStateCode = retailerGstin.slice(0, 2);
  const isIntraState = retailerStateCode === TECH_GIFSY.stateCode;

  // Pure-BigInt rounding (round-half-up): (x * rate% + 50) / 100. No float intermediate.
  if (isIntraState) {
    // CGST 9% + SGST 9% = 18% total, each rounded separately (standard GST line rounding).
    const cgstPaise = (basePaise * 9n + 50n) / 100n;
    const sgstPaise = (basePaise * 9n + 50n) / 100n;
    const gstPaise = cgstPaise + sgstPaise;
    return {
      gstApplicable: true,
      gstType: 'CGST_SGST',
      gstPaise,
      totalPaise: basePaise + gstPaise,
    };
  } else {
    // IGST 18%.
    const igstPaise = (basePaise * 18n + 50n) / 100n;
    return {
      gstApplicable: true,
      gstType: 'IGST',
      gstPaise: igstPaise,
      totalPaise: basePaise + igstPaise,
    };
  }
}
