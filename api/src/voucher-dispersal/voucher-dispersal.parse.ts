import * as XLSX from 'xlsx';
import type { HubbleProduct } from '../hubble/hubble.service';
import { isAmountIssuable } from '../rewards/hubble-catalog.helpers';
import { whatsappSafeVar } from '../rewards/voucher-issuance';

/**
 * Voucher Dispersal — PURE upload parsing + validation (no DB, no Hubble calls). The service resolves
 * the live brand limits first and passes them in, so every rule here is unit-testable.
 *
 * Every row comes back with an explicit status — VALID / INVALID (with a reason) / DUPLICATE (with
 * the row it duplicates). Nothing is dropped silently: blank rows are the only rows skipped.
 */

/** Hard cap on data rows per upload (memory + Hubble throughput). */
export const DISPERSAL_MAX_ROWS = 5000;
/** WhatsApp {{1}} name variable — keep it short and single-line. */
export const DISPERSAL_NAME_MAX = 60;
export const DISPERSAL_NOTE_MAX = 200;

export interface DispersalBrandLimits {
  key: string;
  label: string;
  productId: string;
  /** false when Hubble could not be asked for the live limits (rows of this brand are INVALID). */
  available: boolean;
  unavailableReason: string | null;
  product: HubbleProduct | null;
}

export type ParsedRowStatus = 'VALID' | 'INVALID' | 'DUPLICATE';

export interface ParsedDispersalRow {
  rowNumber: number;
  rawPhone: string;
  phone: string | null;
  /** Set only on the first row of the file for this phone (the one-voucher-per-phone owner). */
  dedupePhone: string | null;
  name: string;
  amountRupees: number | null;
  brandKey: string | null;
  brandLabel: string | null;
  productId: string | null;
  note: string | null;
  status: ParsedRowStatus;
  invalidReason: string | null;
}

export class DispersalFileError extends Error {}

/** Normalise an Indian mobile to the bare 10 digits (null when it is not one). */
export function normalisePhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = typeof raw === 'number' ? (Number.isInteger(raw) ? raw.toFixed(0) : String(raw)) : String(raw);
  s = s.trim();
  if (!s) return null;
  // Only digits plus the usual separators / a leading +; anything else (letters) → not a phone.
  if (!/^[+\d\s\-().]+$/.test(s)) return null;
  let d = s.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/** Parse a rupee amount cell: a number, or text like "₹1,000" / "1000.00". null when not a number. */
export function parseRupees(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[₹,\s]/g, '').replace(/^(rs\.?|inr)/i, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function fmtRupees(n: number): string {
  return `₹${n.toLocaleString('en-IN')}`;
}

/** Admin-readable description of what a brand can issue. */
export function describeBrandAmounts(product: HubbleProduct): string {
  if (product.denominationType === 'FIXED' && product.denominations.length > 0) {
    return `fixed amounts only: ${product.denominations.map(fmtRupees).join(', ')}`;
  }
  const lo = product.minValue != null ? fmtRupees(product.minValue) : 'any';
  const hi = product.maxValue != null ? fmtRupees(product.maxValue) : 'any';
  return `whole rupees from ${lo} to ${hi}`;
}

type HeaderKey = 'phone' | 'name' | 'amount' | 'brand' | 'note';

function headerKey(h: unknown): HeaderKey | null {
  const k = String(h ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (['phone', 'mobile', 'phonenumber', 'mobilenumber', 'mobileno', 'phoneno'].includes(k)) return 'phone';
  if (k === 'name' || k === 'recipientname') return 'name';
  if (k.startsWith('amount')) return 'amount';
  if (k === 'brand') return 'brand';
  if (k === 'note' || k === 'notes') return 'note';
  return null;
}

/** Read the first worksheet into a header map + raw data rows (blank rows skipped, row numbers kept). */
export function readDispersalSheet(buffer: Buffer): { rowNumber: number; cells: Record<HeaderKey, unknown> }[] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    throw new DispersalFileError('The file could not be read as an Excel workbook. Download the template and fill it in.');
  }
  // The template's first sheet is "Recipients"; fall back to the first sheet.
  const sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase() === 'recipients') ?? wb.SheetNames[0];
  if (!sheetName) throw new DispersalFileError('The workbook has no worksheet.');
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: null, raw: true });
  if (aoa.length === 0) throw new DispersalFileError('The sheet is empty. Download the template and fill it in.');
  const header = (aoa[0] ?? []) as unknown[];
  const col: Partial<Record<HeaderKey, number>> = {};
  header.forEach((h, i) => {
    const k = headerKey(h);
    if (k && col[k] === undefined) col[k] = i;
  });
  const missing = (['phone', 'name', 'amount', 'brand'] as HeaderKey[]).filter((k) => col[k] === undefined);
  if (missing.length) {
    throw new DispersalFileError(
      `Missing column(s): ${missing.map((m) => ({ phone: 'Phone', name: 'Name', amount: 'Amount (₹)', brand: 'Brand', note: 'Note' })[m]).join(', ')}. Expected columns: Phone, Name, Amount (₹), Brand, Note (optional) — download the template.`,
    );
  }
  const out: { rowNumber: number; cells: Record<HeaderKey, unknown> }[] = [];
  for (let ri = 1; ri < aoa.length; ri++) {
    const r = (aoa[ri] ?? []) as unknown[];
    const cells = {
      phone: r[col.phone!],
      name: r[col.name!],
      amount: r[col.amount!],
      brand: r[col.brand!],
      note: col.note !== undefined ? r[col.note] : null,
    } as Record<HeaderKey, unknown>;
    const blank = Object.values(cells).every((v) => v === null || v === undefined || String(v).trim() === '');
    if (blank) continue;
    out.push({ rowNumber: ri + 1, cells });
  }
  if (out.length === 0) throw new DispersalFileError('No recipient rows found under the header.');
  if (out.length > DISPERSAL_MAX_ROWS) {
    throw new DispersalFileError(`Too many rows (${out.length}). The limit is ${DISPERSAL_MAX_ROWS} per campaign — split the file.`);
  }
  return out;
}

/**
 * Validate raw rows against the live brand limits. Rules (all visible as invalidReason):
 *  - phone: a 10-digit Indian mobile (+91 / 0 prefixes accepted and stripped);
 *  - name: required, single line, ≤ DISPERSAL_NAME_MAX;
 *  - brand: a configured brand (key or label, case-insensitive) whose live limits Hubble returned;
 *  - amount: whole rupees > 0, within the brand's min/max, on its fixed list when it has one;
 *  - duplicates: the FIRST row for a phone owns it; every later row with that phone is DUPLICATE.
 */
export function validateDispersalRows(
  raw: { rowNumber: number; cells: Record<string, unknown> }[],
  brands: DispersalBrandLimits[],
): ParsedDispersalRow[] {
  const byKey = new Map<string, DispersalBrandLimits>();
  for (const b of brands) {
    byKey.set(b.key.toLowerCase(), b);
    byKey.set(b.label.toLowerCase(), b);
  }
  const owner = new Map<string, number>();
  return raw.map(({ rowNumber, cells }) => {
    const reasons: string[] = [];
    const rawPhone = cells.phone === null || cells.phone === undefined
      ? ''
      : typeof cells.phone === 'number' && Number.isInteger(cells.phone)
        ? cells.phone.toFixed(0)
        : String(cells.phone).trim();
    const phone = normalisePhone(cells.phone);
    if (!rawPhone) reasons.push('Phone is missing');
    else if (!phone) reasons.push('Phone is not a valid 10-digit Indian mobile number');

    const name = whatsappSafeVar(String(cells.name ?? ''));
    if (!name) reasons.push('Name is missing');
    else if (name.length > DISPERSAL_NAME_MAX) reasons.push(`Name is longer than ${DISPERSAL_NAME_MAX} characters`);

    const brandRaw = String(cells.brand ?? '').trim();
    const brand = brandRaw ? byKey.get(brandRaw.toLowerCase()) ?? null : null;
    if (!brandRaw) reasons.push('Brand is missing');
    else if (!brand) reasons.push(`Unknown brand "${brandRaw}" — use one from the template dropdown`);
    else if (!brand.available || !brand.product) {
      reasons.push(`Brand ${brand.label} limits could not be loaded from Hubble (${brand.unavailableReason ?? 'unavailable'}) — upload again later`);
    }

    const amountIn = parseRupees(cells.amount);
    let amountRupees: number | null = null;
    if (cells.amount === null || cells.amount === undefined || String(cells.amount).trim() === '') {
      reasons.push('Amount is missing');
    } else if (amountIn === null || amountIn <= 0) {
      reasons.push('Amount must be a positive number of rupees');
    } else if (!Number.isInteger(amountIn)) {
      amountRupees = amountIn;
      reasons.push('Amount must be whole rupees (no paise)');
    } else {
      amountRupees = amountIn;
      if (brand?.available && brand.product && !isAmountIssuable(brand.product, amountIn)) {
        reasons.push(`${fmtRupees(amountIn)} is not issuable for ${brand.label} (${describeBrandAmounts(brand.product)})`);
      }
    }

    const noteRaw = cells.note === null || cells.note === undefined ? '' : whatsappSafeVar(String(cells.note));
    const note = noteRaw ? noteRaw.slice(0, DISPERSAL_NOTE_MAX) : null;

    let status: ParsedRowStatus = reasons.length ? 'INVALID' : 'VALID';
    let invalidReason: string | null = reasons.length ? reasons.join('; ') : null;
    let dedupePhone: string | null = null;
    if (phone) {
      const first = owner.get(phone);
      if (first === undefined) {
        owner.set(phone, rowNumber);
        dedupePhone = phone;
      } else {
        status = 'DUPLICATE';
        invalidReason = `Same phone as row ${first} — only one voucher per phone per campaign`;
      }
    }

    return {
      rowNumber,
      rawPhone,
      phone,
      dedupePhone,
      name: name.slice(0, 200),
      amountRupees,
      brandKey: brand?.key ?? null,
      brandLabel: brand?.label ?? (brandRaw || null),
      productId: brand?.productId ?? null,
      note,
      status,
      invalidReason,
    };
  });
}
