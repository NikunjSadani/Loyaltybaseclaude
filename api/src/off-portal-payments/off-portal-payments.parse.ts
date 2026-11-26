/**
 * Off-portal payments register — the PURE half: template, file parsing and per-row validation (no DB).
 * Owner spec 2026-11-25 (platform-wide). The service (off-portal-payments.service.ts) adds the DB checks (outlet match,
 * PAN mismatch, duplicates, legacy TDS rows, fund opening) on top of these parsed rows.
 *
 * PII: nothing here logs. Values are returned to the caller only.
 */
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '../common/xlsx';
import { istDateKey } from '../common/ist-date';
import { istDayStartInstant, parseDateCell, parseForPeriodCell } from '../tds/tds.helpers';
import { normalisePan } from '../tds/tds-194r.shared';

export const OFF_PORTAL_TEMPLATE_HEADERS = [
  'Outlet ID',
  'Outlet name',
  'Phone',
  'PAN',
  'Bank account no.',
  'IFSC',
  'UPI ID',
  'Amount (₹)',
  'Payment date',
  'UTR / reference',
  'Payment type (Incentive / Visibility)',
  'Cash or Gift',
  'Month (YYYY-MM)',
  'Narration',
] as const;

export type OffPortalField =
  | 'outletCode'
  | 'outletName'
  | 'phone'
  | 'pan'
  | 'bankAccount'
  | 'ifsc'
  | 'upi'
  | 'amount'
  | 'paymentDate'
  | 'utr'
  | 'paymentType'
  | 'mode'
  | 'period'
  | 'narration';

/** Accepted header spellings (lower-case words, "(…)" hints removed). */
const HEADER_ALIASES: Record<OffPortalField, string[]> = {
  outletCode: ['outlet id', 'outlet code', 'outletid', 'outlet'],
  outletName: ['outlet name', 'name', 'payee name', 'retailer name'],
  phone: ['phone', 'mobile', 'phone number', 'mobile number', 'phone no', 'mobile no'],
  pan: ['pan', 'pan no', 'pan number'],
  bankAccount: ['bank account no', 'bank account number', 'bank account', 'account number', 'account no', 'a c no'],
  ifsc: ['ifsc', 'ifsc code'],
  upi: ['upi id', 'upi', 'vpa'],
  amount: ['amount', 'amount rs', 'amount inr'],
  paymentDate: ['payment date', 'date', 'paid on', 'date of payment'],
  utr: ['utr reference', 'utr', 'reference', 'utr ref', 'utr no', 'reference no', 'utr reference no'],
  paymentType: ['payment type', 'type'],
  mode: ['cash or gift', 'cash gift', 'mode', 'payment mode'],
  period: ['month', 'period', 'month period', 'for month'],
  narration: ['narration', 'remarks', 'remark', 'notes'],
};

const REQUIRED_COLUMNS: OffPortalField[] = ['outletCode', 'outletName', 'amount', 'paymentDate', 'utr', 'paymentType', 'mode'];

export const COLUMN_LABEL: Record<OffPortalField, string> = {
  outletCode: 'Outlet ID',
  outletName: 'Outlet name',
  phone: 'Phone',
  pan: 'PAN',
  bankAccount: 'Bank account no.',
  ifsc: 'IFSC',
  upi: 'UPI ID',
  amount: 'Amount (₹)',
  paymentDate: 'Payment date',
  utr: 'UTR / reference',
  paymentType: 'Payment type',
  mode: 'Cash or Gift',
  period: 'Month',
  narration: 'Narration',
};

/** One row of a single payment. ₹1 crore per row is the plausibility ceiling (a bigger figure is a typo). */
export const MAX_ROW_PAISE = 10_000_000_00n;
/** Rows per file. */
export const MAX_ROWS = 20_000;

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^[0-9]{9,18}$/;
const UPI_RE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/;

export function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Upper-cased trimmed outlet code — THE case-insensitive link key. */
export function outletKeyOf(code: string): string {
  return code.trim().toUpperCase();
}

export function buildOffPortalTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = aoaToSheetSafe([
    [...OFF_PORTAL_TEMPLATE_HEADERS],
    [
      'OUT1001',
      'Sharma Stores',
      '9876543210',
      'ABCDE1234F',
      '',
      '',
      'sharma@okbank',
      2500,
      '15/10/2026',
      'UTR123456789',
      'Incentive',
      'Cash',
      '2026-10',
      'Diwali incentive paid by UPI',
    ],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Off-portal payments');
  const help = aoaToSheetSafe([
    ['Column', 'Required?', 'What to enter'],
    ['Outlet ID', 'Yes', 'The outlet code exactly as on the portal. A code that is not on the portal is kept as an off-portal payee and links automatically when that outlet registers with the same code.'],
    ['Outlet name', 'Yes', 'The payee / outlet name.'],
    ['Phone', 'No', '10-digit mobile number.'],
    ['PAN', 'No', "Payee's PAN. Blank → the portal's PAN for that outlet is used; if there is none, TDS is at the no-PAN rate."],
    ['Bank account no. + IFSC', 'No', 'Both or neither.'],
    ['UPI ID', 'No', 'e.g. name@bank'],
    ['Amount (₹)', 'Yes', 'The amount paid in full, in rupees (up to 2 decimals).'],
    ['Payment date', 'Yes', 'DD/MM/YYYY (or an Excel date). Decides the financial year for TDS and the date in Fund Reconciliation.'],
    ['UTR / reference', 'Cash: yes · Gift: no', 'Bank / UPI reference of the payment.'],
    ['Payment type', 'Yes', 'Incentive or Visibility.'],
    ['Cash or Gift', 'Yes', 'Cash (bank / UPI) or Gift.'],
    ['Month', 'No', 'The month the payment is for (YYYY-MM or Mon-YYYY). Blank → the payment month.'],
    ['Narration', 'No', 'Free text shown in the payout history.'],
    ['', '', 'Delete the example row before uploading. These payments were paid IN FULL: no TDS was withheld.'],
  ]);
  XLSX.utils.book_append_sheet(wb, help, 'How to fill');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export interface ParsedOffPortalRow {
  rowNumber: number;
  outletCode: string;
  outletKey: string;
  outletName: string;
  phone: string | null;
  /** Normalised file PAN, or null when blank. */
  filePan: string | null;
  bankAccountNumber: string | null;
  ifsc: string | null;
  upiId: string | null;
  amountPaise: bigint;
  /** IST calendar day 'YYYY-MM-DD'. */
  paymentDay: string;
  /** 00:00 IST of paymentDay. */
  paymentDate: Date;
  utr: string | null;
  payoutStream: 'INCENTIVE' | 'VISIBILITY';
  paymentMode: 'CASH' | 'GIFT';
  period: string;
  narration: string | null;
}

export interface InvalidOffPortalRow {
  rowNumber: number;
  outletCode: string;
  outletName: string;
  errors: string[];
}

export interface ParsedOffPortalFile {
  /** A whole-file problem (no rows read) — set ⇒ rows/invalid are empty. */
  fileError: string | null;
  rowsInFile: number;
  blankRows: number;
  rows: ParsedOffPortalRow[];
  invalid: InvalidOffPortalRow[];
  sha256: string;
}

const str = (v: unknown): string => (v == null ? '' : String(v)).replace(/ /g, ' ').trim();

/** "₹ 1,234.50" / 1234.5 → paise, or an error. */
export function parseAmountCell(raw: unknown): { paise: bigint } | { error: string } {
  if (raw == null || str(raw) === '') return { error: 'Amount is required' };
  let s: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { error: `Amount "${raw}" is not a number` };
    s = raw.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  } else {
    s = str(raw).replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return { error: `Amount "${str(raw)}" is not a valid amount` };
  const frac = m[2] ?? '';
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) return { error: `Amount "${str(raw)}" has more than 2 decimals` };
  const paise = BigInt(m[1]) * 100n + BigInt((frac + '00').slice(0, 2));
  if (paise <= 0n) return { error: 'Amount must be more than ₹0' };
  if (paise > MAX_ROW_PAISE) return { error: 'Amount is over ₹1,00,00,000 for one payment — check the figure' };
  return { paise };
}

/** 10-digit Indian mobile (+91 / 0 prefix tolerated). */
export function parsePhoneCell(raw: unknown): { phone: string | null } | { error: string } {
  const s = str(raw);
  if (!s) return { phone: null };
  let d = s.replace(/[\s\-()]/g, '');
  if (typeof raw === 'number') d = String(Math.trunc(raw));
  d = d.replace(/^\+?91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
  if (!/^[6-9]\d{9}$/.test(d)) return { error: 'Phone must be a 10-digit mobile number' };
  return { phone: d };
}

/** The file's columns: field → column index (−1 when absent). */
export function mapColumns(header: unknown[]): Record<OffPortalField, number> {
  const norm = header.map((h) => normaliseHeader(str(h)));
  const out = {} as Record<OffPortalField, number>;
  for (const f of Object.keys(HEADER_ALIASES) as OffPortalField[]) {
    out[f] = norm.findIndex((h) => h !== '' && HEADER_ALIASES[f].includes(h));
  }
  return out;
}

/**
 * Parse + validate an off-portal payments file. Every row is either a ParsedOffPortalRow or an InvalidOffPortalRow
 * with ALL its problems (never silently dropped). Blank rows are counted, not listed. `now` is injectable for tests.
 */
export function parseOffPortalFile(buf: Buffer, now: Date = new Date()): ParsedOffPortalFile {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const empty = (fileError: string, rowsInFile = 0): ParsedOffPortalFile => ({
    fileError,
    rowsInFile,
    blankRows: 0,
    rows: [],
    invalid: [],
    sha256,
  });
  let data: unknown[][];
  try {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
    const name = wb.SheetNames[0];
    if (!name) return empty('The file has no sheet.');
    data = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: '', raw: true }) as unknown[][];
  } catch {
    return empty('The file could not be read — upload the .xlsx template.');
  }
  if (data.length < 2) return empty('The file has no data rows.');
  const cols = mapColumns(data[0] ?? []);
  const missing = REQUIRED_COLUMNS.filter((f) => cols[f] < 0);
  if (missing.length) {
    return empty(
      `The file is missing required column(s): ${missing.map((f) => COLUMN_LABEL[f]).join(', ')}. Please use the template — no rows were read.`,
      data.length - 1,
    );
  }
  if (data.length - 1 > MAX_ROWS) return empty(`The file has ${data.length - 1} rows — the limit is ${MAX_ROWS} per upload. Split the file.`, data.length - 1);

  const todayKey = istDateKey(now);
  const rows: ParsedOffPortalRow[] = [];
  const invalid: InvalidOffPortalRow[] = [];
  let blankRows = 0;
  const cell = (row: unknown[], f: OffPortalField): unknown => (cols[f] >= 0 ? row[cols[f]] : '');

  for (let i = 1; i < data.length; i++) {
    const row = (data[i] ?? []) as unknown[];
    const rowNumber = i + 1;
    if (row.every((c) => str(c) === '')) {
      blankRows++;
      continue;
    }
    const errors: string[] = [];
    const outletCode = str(cell(row, 'outletCode'));
    const outletName = str(cell(row, 'outletName'));
    if (!outletCode) errors.push('Outlet ID is required');
    else if (outletCode.length > 64) errors.push('Outlet ID is longer than 64 characters');
    if (!outletName) errors.push('Outlet name is required');
    else if (outletName.length > 200) errors.push('Outlet name is longer than 200 characters');

    const phone = parsePhoneCell(cell(row, 'phone'));
    if ('error' in phone) errors.push(phone.error);

    let filePan: string | null = null;
    const panRaw = str(cell(row, 'pan'));
    if (panRaw) {
      const p = normalisePan(panRaw);
      if (!PAN_RE.test(p)) errors.push(`PAN "${panRaw}" is not a valid PAN (e.g. ABCDE1234F) — leave it blank if there is none`);
      else filePan = p;
    }

    const acc = str(cell(row, 'bankAccount')).replace(/[\s-]/g, '');
    const ifsc = str(cell(row, 'ifsc')).toUpperCase().replace(/\s/g, '');
    if (acc && !ACCOUNT_RE.test(acc)) errors.push('Bank account no. must be 9–18 digits');
    if (ifsc && !IFSC_RE.test(ifsc)) errors.push(`IFSC "${ifsc}" is not valid (e.g. HDFC0001234)`);
    if (acc && !ifsc) errors.push('IFSC is required with a bank account no.');
    if (ifsc && !acc) errors.push('Bank account no. is required with an IFSC');

    const upi = str(cell(row, 'upi'));
    if (upi && !UPI_RE.test(upi)) errors.push(`UPI ID "${upi}" is not valid (e.g. name@bank)`);

    const amount = parseAmountCell(cell(row, 'amount'));
    if ('error' in amount) errors.push(amount.error);

    let paymentDay = '';
    const dateRaw = cell(row, 'paymentDate');
    const d = parseDateCell(dateRaw);
    if (!d) errors.push(str(dateRaw) ? `Payment date "${str(dateRaw)}" is not a date (use DD/MM/YYYY)` : 'Payment date is required');
    else {
      // A date-only cell is 00:00 UTC of that calendar date (05:30 IST — same IST day); a timed one → its IST day.
      paymentDay = istDateKey(d);
      if (paymentDay > todayKey) errors.push(`Payment date ${paymentDay} is in the future`);
      if (paymentDay < '2015-04-01') errors.push(`Payment date ${paymentDay} is too old`);
    }

    const typeRaw = str(cell(row, 'paymentType')).toLowerCase();
    let payoutStream: 'INCENTIVE' | 'VISIBILITY' | null = null;
    if (typeRaw === 'incentive') payoutStream = 'INCENTIVE';
    else if (typeRaw === 'visibility') payoutStream = 'VISIBILITY';
    else errors.push(typeRaw ? `Payment type "${str(cell(row, 'paymentType'))}" must be Incentive or Visibility` : 'Payment type is required (Incentive or Visibility)');

    const modeRaw = str(cell(row, 'mode')).toLowerCase();
    let paymentMode: 'CASH' | 'GIFT' | null = null;
    if (modeRaw === 'cash') paymentMode = 'CASH';
    else if (modeRaw === 'gift') paymentMode = 'GIFT';
    else errors.push(modeRaw ? `Cash or Gift "${str(cell(row, 'mode'))}" must be Cash or Gift` : 'Cash or Gift is required');

    const utr = str(cell(row, 'utr'));
    if (paymentMode === 'CASH' && !utr) errors.push('UTR / reference is required for a cash payment');
    if (utr.length > 64) errors.push('UTR / reference is longer than 64 characters');

    let period = paymentDay ? paymentDay.slice(0, 7) : '';
    const per = parseForPeriodCell(cell(row, 'period'));
    if ('error' in per) errors.push(`Month: ${per.error}`);
    else if ('period' in per) period = per.period;

    const narration = str(cell(row, 'narration'));
    if (narration.length > 500) errors.push('Narration is longer than 500 characters');

    if (errors.length || !('paise' in amount) || !payoutStream || !paymentMode || !paymentDay) {
      invalid.push({ rowNumber, outletCode, outletName, errors });
      continue;
    }
    rows.push({
      rowNumber,
      outletCode,
      outletKey: outletKeyOf(outletCode),
      outletName,
      phone: 'phone' in phone ? phone.phone : null,
      filePan,
      bankAccountNumber: acc || null,
      ifsc: ifsc || null,
      upiId: upi || null,
      amountPaise: amount.paise,
      paymentDay,
      paymentDate: istDayStartInstant(paymentDay),
      utr: utr || null,
      payoutStream,
      paymentMode,
      period,
      narration: narration || null,
    });
  }
  return { fileError: null, rowsInFile: data.length - 1, blankRows, rows, invalid, sha256 };
}

/** The duplicate key: same outlet + amount + payment day + UTR (case / spacing-insensitive). */
export function duplicateKey(r: { outletKey: string; amountPaise: bigint; paymentDay: string; utr: string | null }): string {
  return [r.outletKey, r.amountPaise.toString(), r.paymentDay, (r.utr ?? '').replace(/\s/g, '').toUpperCase()].join('|');
}

// ── PII masking (everyone but a Gifsy admin) ─────────────────────────────────────────────────────

export const maskTail = (v: string | null | undefined, keep = 4): string | null =>
  v ? (v.length <= keep ? '•'.repeat(v.length) : `${'•'.repeat(Math.min(6, v.length - keep))}${v.slice(-keep)}`) : null;
export const maskPanValue = (p: string | null | undefined): string | null => (p ? `${p.slice(0, 2)}•••••${p.slice(-3)}` : null);
export const maskUpi = (u: string | null | undefined): string | null => {
  if (!u) return null;
  const at = u.indexOf('@');
  return at > 0 ? `${u.slice(0, 1)}•••${u.slice(at)}` : maskTail(u);
};
