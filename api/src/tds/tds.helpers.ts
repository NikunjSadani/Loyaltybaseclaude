/**
 * TDS calc helpers + xlsx parse/build helpers — pure, side-effect-free, unit-tested.
 *
 * All money is in integer paise (BigInt). TDS is rounded to the nearest whole
 * rupee = nearest 100 paise. Model: grossed-up / payer-borne — the partner
 * receives the full amount; the payer bears TDS ON TOP:
 *   TDS = base × rate / (1 − rate)
 *
 * Exact factors (grossing-up denominators):
 *   194R PAN        10/90   (10 ÷ (100−10))
 *   194R no-PAN     20/80   (20 ÷ (100−20))
 *   194C indiv/HUF   1/99   ( 1 ÷ (100−1))
 *   194C others      2/98   ( 2 ÷ (100−2))
 *   194C no-PAN     20/80   (20 ÷ (100−20))
 *
 * Rounding: add half the denominator before integer division (round half-up to
 * the nearest 100 paise = 1 rupee). BigInt arithmetic only — no floating-point.
 */

import { createHash } from 'crypto';
import * as XLSX from 'xlsx';
import { rupeesToPaise, toPaiseBigInt } from '../common/money';
import type { UploadResult, UploadRowError } from './dto/tds.dto';

// ─── Re-export so consumers only need to import from tds.helpers ─────────────
export type { UploadResult, UploadRowError };

// ─── Spreadsheet formula-injection guard ─────────────────────────────────────

/**
 * Neutralise spreadsheet formula injection. A cell value that begins with
 * `= + - @` (or a leading tab/CR) is interpreted as a live formula by Excel /
 * Google Sheets — a partner-supplied deductee name like `=WEBSERVICE("http://evil")`
 * or `=cmd()` would execute when finance opens the TDS export. Prefix such
 * values with an apostrophe so they are always treated as text.
 *
 * Mirrors the proven `cellSafe` in invoices/invoice.helpers.ts. It is duplicated
 * here (not imported) because that one is module-private and the TDS module may
 * only touch files under src/tds — see the upload/export sanitisation.
 */
export function cellSafe(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

// ─── File-level dedup hash (deterministic uploadBatchId) ─────────────────────

/**
 * Compute a DETERMINISTIC sha256 over the canonical content of an off-platform
 * upload's parsed rows. Re-uploading the SAME file yields the SAME hash, so
 * every row collides on the `tds_off_platform_entries_dedup_unique` partial index
 * (which includes uploadBatchId) → skipped instead of double-counted. A DIFFERENT
 * file (even one whose rows happen to match an earlier row) gets a different hash
 * → its rows insert, preserving a genuine repeat 194R entry. (Owner: FILE-LEVEL dedup.)
 *
 * Canonicalisation: per-row tuple of the dedup-relevant fields, in file order,
 * joined with field/row separators. Dates use the UTC ISO instant; amount uses
 * the BigInt decimal string.
 */
export function offPlatformFileHash(rows: ParsedOffPlatformRow[]): string {
  const canonical = rows
    .map((r) =>
      [
        r.entryDate.toISOString(),
        r.panNumber,
        r.amountPaise.toString(),
        r.outletCode ?? '',
      ].join(''),
    )
    .join('');
  return `OP-${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Deterministic sha256 over a deposit upload's parsed rows. See offPlatformFileHash. */
export function depositFileHash(rows: ParsedDepositRow[]): string {
  const canonical = rows
    .map((r) =>
      [
        r.depositDate.toISOString(),
        r.panNumber,
        r.amountPaise.toString(),
        r.outletCode ?? '',
      ].join(''),
    )
    .join('');
  return `DEP-${createHash('sha256').update(canonical).digest('hex')}`;
}

// ─── Template builders ───────────────────────────────────────────────────────

/**
 * Build a blank .xlsx template for the off-platform 194R upload.
 * Columns: Date · PAN · Outlet Code · Amount (₹)
 */
export function buildOffPlatformTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  const header = XLSX.utils.aoa_to_sheet([['Date', 'PAN', 'Outlet Code', 'Amount (₹)']]);
  XLSX.utils.book_append_sheet(wb, header, 'TDS 194R Off-Platform');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * Build a blank .xlsx template for the TDS deposit upload.
 * Columns: Date · Outlet Code · PAN · Amount (₹)
 */
export function buildDepositTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  const header = XLSX.utils.aoa_to_sheet([['Date', 'Outlet Code', 'PAN', 'Amount (₹)']]);
  XLSX.utils.book_append_sheet(wb, header, 'TDS Deposits');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─── Parsed row types ────────────────────────────────────────────────────────

export interface ParsedOffPlatformRow {
  entryDate: Date;
  panNumber: string;
  outletCode: string | null;
  amountPaise: bigint;
}

export interface ParsedDepositRow {
  depositDate: Date;
  outletCode: string | null;
  panNumber: string;
  amountPaise: bigint;
}

// ─── Parse helpers ───────────────────────────────────────────────────────────

/**
 * Parse a cell value as a JavaScript Date.
 * Handles XLSX serial numbers (number), ISO strings, and Excel date strings.
 * Returns null if unparseable.
 */
function parseDateCell(raw: unknown): Date | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    // XLSX stores dates as serial number — convert using xlsx
    const dateStr = XLSX.SSF.format('yyyy-mm-dd', raw);
    const d = new Date(dateStr + 'T00:00:00Z');
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Try ISO or common date formats
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d;
    // Try DD/MM/YYYY
    const dm = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (dm) {
      const [, dd, mm, yyyy] = dm;
      const y = yyyy.length === 2 ? `20${yyyy}` : yyyy;
      const d2 = new Date(`${y}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00Z`);
      return isNaN(d2.getTime()) ? null : d2;
    }
    return null;
  }
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  return null;
}

/** Read the first worksheet from an xlsx ArrayBuffer as an array-of-arrays. */
function readFirstSheet(ab: ArrayBufferLike): unknown[][] {
  const wb = XLSX.read(ab, { type: 'array', cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const ws = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' }) as unknown[][];
}

/**
 * Parse an off-platform 194R upload xlsx.
 * Expected columns (row 0 = header): Date · PAN · Outlet Code · Amount (₹)
 *
 * Validation per row:
 *   - Date: required + parseable
 *   - PAN: required, non-empty → uppercase + trim
 *   - Outlet Code: optional
 *   - Amount (₹): required, positive number → rupeesToPaise → BigInt
 *
 * Returns an UploadResult and the accepted rows.
 */
export function parseOffPlatformUpload(ab: ArrayBufferLike): {
  result: UploadResult;
  rows: ParsedOffPlatformRow[];
} {
  const data = readFirstSheet(ab);
  if (data.length < 2) {
    return {
      result: { processed: 0, succeeded: 0, skipped: 0, failed: 0, errors: [] },
      rows: [],
    };
  }

  // Header detection (row 0) — find column indices
  const header = (data[0] as unknown[]).map((h) => String(h ?? '').trim().toLowerCase());
  const colDate = header.findIndex((h) => h === 'date');
  const colPan = header.findIndex((h) => h === 'pan');
  const colOutlet = header.findIndex((h) => h.includes('outlet'));
  const colAmount = header.findIndex((h) => h.includes('amount'));

  const errors: UploadRowError[] = [];
  const accepted: ParsedOffPlatformRow[] = [];
  let skipped = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i] as unknown[];
    const rowNum = i + 1; // 1-based, row 1 = header

    // Skip entirely blank rows
    const allBlank = row.every((c) => c == null || String(c).trim() === '');
    if (allBlank) { skipped++; continue; }

    // Date
    const rawDate = colDate >= 0 ? row[colDate] : undefined;
    const entryDate = parseDateCell(rawDate);
    if (!entryDate) {
      errors.push({ row: rowNum, message: `Row ${rowNum}: invalid or missing Date ("${rawDate}")` });
      continue;
    }

    // PAN — required, non-empty
    const rawPan = colPan >= 0 ? String(row[colPan] ?? '').trim().toUpperCase() : '';
    if (!rawPan) {
      errors.push({ row: rowNum, message: `Row ${rowNum}: PAN is required and must not be blank` });
      continue;
    }

    // Outlet Code — optional
    const rawOutlet = colOutlet >= 0 ? String(row[colOutlet] ?? '').trim() : '';
    const outletCode = rawOutlet || null;

    // Amount (₹) → paise
    const rawAmount = colAmount >= 0 ? row[colAmount] : undefined;
    const amountRupees = typeof rawAmount === 'number' ? rawAmount
      : parseFloat(String(rawAmount ?? '').replace(/[^0-9.]/g, ''));
    if (isNaN(amountRupees) || amountRupees <= 0) {
      errors.push({ row: rowNum, message: `Row ${rowNum}: Amount must be a positive number (got "${rawAmount}")` });
      continue;
    }

    const amountPaise = toPaiseBigInt(rupeesToPaise(amountRupees));
    accepted.push({ entryDate, panNumber: rawPan, outletCode, amountPaise });
  }

  return {
    result: {
      processed: data.length - 1,
      succeeded: accepted.length,
      skipped,
      failed: errors.length,
      errors,
    },
    rows: accepted,
  };
}

/**
 * Parse a TDS deposit upload xlsx.
 * Expected columns: Date · Outlet Code · PAN · Amount (₹)
 *
 * Validation per row:
 *   - Date: required + parseable
 *   - PAN: required, non-empty → uppercase + trim
 *   - Outlet Code: optional
 *   - Amount (₹): required, positive number → paise
 */
export function parseDepositUpload(ab: ArrayBufferLike): {
  result: UploadResult;
  rows: ParsedDepositRow[];
} {
  const data = readFirstSheet(ab);
  if (data.length < 2) {
    return {
      result: { processed: 0, succeeded: 0, skipped: 0, failed: 0, errors: [] },
      rows: [],
    };
  }

  const header = (data[0] as unknown[]).map((h) => String(h ?? '').trim().toLowerCase());
  const colDate = header.findIndex((h) => h === 'date');
  const colOutlet = header.findIndex((h) => h.includes('outlet'));
  const colPan = header.findIndex((h) => h === 'pan');
  const colAmount = header.findIndex((h) => h.includes('amount'));

  const errors: UploadRowError[] = [];
  const accepted: ParsedDepositRow[] = [];
  let skipped = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i] as unknown[];
    const rowNum = i + 1;

    const allBlank = row.every((c) => c == null || String(c).trim() === '');
    if (allBlank) { skipped++; continue; }

    const rawDate = colDate >= 0 ? row[colDate] : undefined;
    const depositDate = parseDateCell(rawDate);
    if (!depositDate) {
      errors.push({ row: rowNum, message: `Row ${rowNum}: invalid or missing Date ("${rawDate}")` });
      continue;
    }

    const rawOutlet = colOutlet >= 0 ? String(row[colOutlet] ?? '').trim() : '';
    const outletCode = rawOutlet || null;

    const rawPan = colPan >= 0 ? String(row[colPan] ?? '').trim().toUpperCase() : '';
    if (!rawPan) {
      errors.push({ row: rowNum, message: `Row ${rowNum}: PAN is required and must not be blank` });
      continue;
    }

    const rawAmount = colAmount >= 0 ? row[colAmount] : undefined;
    const amountRupees = typeof rawAmount === 'number' ? rawAmount
      : parseFloat(String(rawAmount ?? '').replace(/[^0-9.]/g, ''));
    if (isNaN(amountRupees) || amountRupees <= 0) {
      errors.push({ row: rowNum, message: `Row ${rowNum}: Amount must be a positive number (got "${rawAmount}")` });
      continue;
    }

    const amountPaise = toPaiseBigInt(rupeesToPaise(amountRupees));
    accepted.push({ depositDate, outletCode, panNumber: rawPan, amountPaise });
  }

  return {
    result: {
      processed: data.length - 1,
      succeeded: accepted.length,
      skipped,
      failed: errors.length,
      errors,
    },
    rows: accepted,
  };
}

// ─── Section enum mapping ─────────────────────────────────────────────────────

/** Map URL query param '194R'|'194C' to Prisma enum value. */
export function sectionParamToEnum(section: '194R' | '194C'): 'SEC_194R' | 'SEC_194C' {
  return section === '194R' ? 'SEC_194R' : 'SEC_194C';
}

/** One rate expressed as an irreducible integer fraction num/den. */
export interface TdsRate {
  num: number; // e.g. 10
  den: number; // e.g. 90
}

/**
 * Round a paise amount to the nearest whole rupee (100 paise).
 * Uses integer "round half-up": add 50 paise, then floor-divide by 100,
 * then multiply by 100.
 */
export function roundToRupeePaise(paise: bigint): bigint {
  // Handle negatives symmetrically (shouldn't occur in TDS context, but guard anyway)
  if (paise < 0n) return -roundToRupeePaise(-paise);
  return ((paise + 50n) / 100n) * 100n;
}

/**
 * Compute grossed-up TDS: TDS = base × num / den, rounded to nearest rupee.
 *
 * @param basePaise  - the benefit amount in paise (BigInt)
 * @param rate       - { num, den } where TDS rate = num/(num+den) expressed as
 *                     the over-the-full fraction: num/(100−ratePct) = num/den.
 * @returns          - TDS in paise (rounded to nearest 100 paise)
 */
export function grossUpTdsPaise(basePaise: bigint, rate: TdsRate): bigint {
  const { num, den } = rate;
  const rawPaise = basePaise * BigInt(num);
  return roundToRupeePaise(rawPaise / BigInt(den));
}

// ─── Section-specific rate factories ────────────────────────────────────────

/** 194R rate for a PAN holder (10/90) or no-PAN (20/80). */
export function rate194R(hasPan: boolean): TdsRate {
  return hasPan ? { num: 10, den: 90 } : { num: 20, den: 80 };
}

/**
 * 194C rate:
 *   - no PAN           → 20/80
 *   - INDIVIDUAL / HUF → 1/99
 *   - everything else  → 2/98
 */
export function rate194C(hasPan: boolean, entityType?: string | null): TdsRate {
  if (!hasPan) return { num: 20, den: 80 };
  if (entityType === 'INDIVIDUAL' || entityType === 'HUF') return { num: 1, den: 99 };
  return { num: 2, den: 98 };
}

// ─── Financial-year helpers ──────────────────────────────────────────────────

export interface FyInfo {
  fyLabel: string; // e.g. "2025-26"
  start: Date;     // 1 Apr of the year
  endExclusive: Date; // 1 Apr of the next year
}

/** India Standard Time is UTC+5:30 — the FY boundary is anchored here, not UTC. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * The UTC instant for 00:00 IST on 1 Apr of `year` — i.e. the start of the Indian
 * financial year. 1 Apr 00:00 IST = 31 Mar 18:30 UTC, so we take the UTC midnight
 * and shift back by the IST offset. Using this for the window boundary means a
 * payment timestamped 31 Mar 18:30–23:59 UTC (= 1 Apr 00:00–05:29 IST) correctly
 * lands in the NEW financial year, not the prior one.
 */
function aprilFirstIstInstant(year: number): Date {
  return new Date(Date.UTC(year, 3, 1) - IST_OFFSET_MS);
}

/**
 * Given any Date, return the FY that contains it (boundaries anchored to IST).
 * FY n = 1 Apr 00:00 IST (year n) → 1 Apr 00:00 IST (year n+1), exclusive end.
 * e.g. 2026-01-15 → FY 2025-26 (starts 1 Apr 2025).
 */
export function financialYear(date: Date): FyInfo {
  // Shift the instant into IST wall-clock before extracting month/year, so a
  // timestamp at e.g. 31 Mar 19:00 UTC (= 1 Apr 00:30 IST) is treated as April.
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const month = ist.getUTCMonth(); // 0-indexed; April = 3
  const year = ist.getUTCFullYear();
  // If January–March (months 0-2), we're in the FY that started the prior April.
  const fyStartYear = month < 3 ? year - 1 : year;
  const start = aprilFirstIstInstant(fyStartYear);         // 1 Apr 00:00 IST
  const endExclusive = aprilFirstIstInstant(fyStartYear + 1); // 1 Apr 00:00 IST (next year)
  const fyLabel = `${fyStartYear}-${String(fyStartYear + 1).slice(2)}`;
  return { fyLabel, start, endExclusive };
}

/** Returns FyInfo for the current system date (UTC). */
export function fyOfToday(): FyInfo {
  return financialYear(new Date());
}

/**
 * Parse a "YYYY-YY" label (e.g. "2025-26") back into FyInfo.
 * Throws if the label is malformed or the short year is inconsistent.
 */
export function fyFromLabel(label: string): FyInfo {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) throw new Error(`Invalid FY label: "${label}". Expected "YYYY-YY", e.g. "2025-26"`);
  const startYear = parseInt(m[1], 10);
  const expectedEnd = (startYear + 1) % 100;
  if (parseInt(m[2], 10) !== expectedEnd) {
    throw new Error(`Inconsistent FY label "${label}": end year should be ${String(startYear + 1).slice(2)}`);
  }
  return financialYear(new Date(Date.UTC(startYear, 3, 15))); // mid-April = safely in FY
}
