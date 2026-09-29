import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '../common/xlsx';
import { startOfIstDay } from '../common/ist-date';

/**
 * Credits & Payouts — pure helpers, ported verbatim from the platform libs:
 *   - generatePayoutFileBuffer  (platform/src/lib/credits-payouts-payout-download.ts)
 *   - parseUtrUpload / isValidUtr (platform/src/lib/credits-payouts-utr.ts)
 *
 * These are deliberately self-contained (no DB, no Nest DI) — the service loads
 * data from Prisma and feeds it in, exactly as the source API routes did. The
 * minimal local interfaces below mirror the relevant shapes from platform's
 * `@/types` (PayoutBatch / PayoutBatchRow / UtrParseResult / UtrUploadRow).
 */

// ─── Payout-file shapes (subset of platform's @/types) ────────────────────────

export interface PayoutBatchRow {
  outletId: string;
  outletName: string;
  phone: string;
  bankName: string;
  accountNumber: string;
  ifscCode: string;
  upiId: string;
  kycStatus: string;
  /**
   * "Payout Amount" column value in the Excel file — **rupees** (not paise).
   * The service converts from paise using paiseToRupees() before building this
   * row; no conversion is performed inside the helper.
   */
  amount: number;
  isDeactivated: boolean;
  utrStatus: 'PENDING' | 'PAID' | 'FAILED';
  utr?: string;
  paidAt?: string;
  failureReason?: string;
  entryIds: string[];
}

export interface PayoutBatch {
  id: string;
  creditBatchId: string;
  period: string;
  groupType: 'STANDARD' | 'SEPARATE';
  fieldId?: string;
  fieldName?: string;
  status: string;
  downloadedAt: string;
  downloadedBy: string;
  totalAmount: number;
  bankSnapshots: unknown[];
  rows: PayoutBatchRow[];
}

// ─── Payout file generator ────────────────────────────────────────────────────

export const PAYOUT_FILE_HEADERS = [
  'Batch ID',
  'Outlet ID',
  'Outlet Name',
  'Phone',
  'Bank Name',
  'Account Number',
  'IFSC',
  'UPI ID',
  'KYC Status',
  'Deactivated',
  'Payout Amount',
  'UTR',
  'Payment Date',
  'Success/Failure',
  'Remarks',
];

export function generatePayoutFileBuffer(batch: PayoutBatch): Buffer {
  const label = new Date(batch.period + '-01').toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });

  const wsData: (string | number | boolean)[][] = [
    [
      `Payout File — ${label}${
        batch.groupType === 'SEPARATE' ? ` (${batch.fieldName ?? batch.fieldId})` : ''
      } — ${batch.id}`,
    ],
    PAYOUT_FILE_HEADERS,
    ...batch.rows.map((r) => [
      batch.id,
      r.outletId,
      r.outletName,
      r.phone,
      r.bankName,
      r.accountNumber,
      r.ifscCode,
      r.upiId,
      r.kycStatus,
      r.isDeactivated ? 'YES' : 'NO',
      r.amount,
      '', // UTR — operator fills
      '', // Payment Date — operator fills (blank = defaults to apply time)
      '', // Success/Failure
      '', // Remarks
    ]),
  ];

  const ws = aoaToSheetSafe(wsData);
  ws['!cols'] = [
    { wch: 18 },
    { wch: 12 },
    { wch: 28 },
    { wch: 14 },
    { wch: 16 },
    { wch: 20 },
    { wch: 14 },
    { wch: 22 },
    { wch: 14 },
    { wch: 12 },
    { wch: 16 },
    { wch: 22 },
    { wch: 16 }, // Payment Date
    { wch: 16 },
    { wch: 30 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payout');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─── UTR upload parser ────────────────────────────────────────────────────────

const UTR_RE = /^[A-Z0-9]{8,22}$/i;

export function isValidUtr(utr: string): boolean {
  return UTR_RE.test(utr.trim());
}

/**
 * Parse a "Payment Date" cell from the payout file.
 *
 * Accepts (blank → no date, no error):
 *   - ISO date-only `YYYY-MM-DD`
 *   - `DD/MM/YYYY` or `DD-MM-YYYY` (Indian operator convention)
 *   - a full ISO datetime (contains a `T`) — used as the exact instant
 *   - an Excel date SERIAL number (what a date-typed cell becomes when the
 *     operator types a date into Excel and the sheet is read without cellDates)
 *   - a Date instance (defensive; only if a caller reads with cellDates)
 *
 * A DATE-ONLY value is normalised to 00:00 IST of that calendar day (reusing
 * startOfIstDay), so the recorded paidAt is the Indian wall-clock day the
 * operator intended regardless of the server timezone. An unparseable / impossible
 * value returns `{ error }` so the row is flagged.
 */
export function parsePaymentDateCell(
  raw: string | number | Date | null | undefined,
): { date?: Date; error?: string } {
  if (raw == null) return {};

  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime())
      ? { error: 'Payment Date is not a valid date.' }
      : { date: startOfIstDay(raw) };
  }

  // Excel stores a date-typed cell as a serial number when read without cellDates.
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      return { error: `Payment Date "${raw}" is not a valid date.` };
    }
    const p = XLSX.SSF.parse_date_code(raw);
    if (!p || !p.y) return { error: `Payment Date "${raw}" is not a valid date.` };
    return buildIstDateOnly(p.y, p.m, p.d, String(raw));
  }

  const s = String(raw).trim();
  if (!s) return {};

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return buildIstDateOnly(+m[1], +m[2], +m[3], s);

  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) return buildIstDateOnly(+m[3], +m[2], +m[1], s);

  // Full ISO datetime (an explicit instant the caller chose) — use as-given.
  if (s.includes('T')) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return { date: d };
  }

  return {
    error: `Payment Date "${s}" is not valid (use YYYY-MM-DD or DD/MM/YYYY).`,
  };
}

/** Validate a Y/M/D triple (rejecting impossible dates like 31/02) and return 00:00 IST of that day. */
function buildIstDateOnly(
  y: number,
  mo: number,
  d: number,
  orig: string,
): { date?: Date; error?: string } {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    return { error: `Payment Date "${orig}" is not a real calendar date.` };
  }
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (
    utc.getUTCFullYear() !== y ||
    utc.getUTCMonth() !== mo - 1 ||
    utc.getUTCDate() !== d
  ) {
    return { error: `Payment Date "${orig}" is not a real calendar date.` };
  }
  return { date: startOfIstDay(utc) };
}

function parseSuccess(raw: string): boolean {
  const v = String(raw).trim().toUpperCase();
  return ['SUCCESS', '1', 'Y', 'YES', 'TRUE'].includes(v);
}

export interface UtrUploadRow {
  rowNum: number;
  outletId: string;
  batchId: string;
  utr: string;
  success: boolean;
  remarks: string;
  status: 'OK' | 'ERROR' | 'SKIP';
  errors: string[];
  /**
   * Parsed "Payment Date" for this row, when the operator filled the cell. Drives
   * the entry's paidAt on apply (else apply-time). Undefined = blank cell.
   */
  paymentDate?: Date;
}

export interface UtrParseResult {
  headerError: string | null;
  rows: UtrUploadRow[];
  hasErrors: boolean;
  canProceed: boolean;
  summary: {
    total: number;
    ok: number;
    skipped: number;
    errors: number;
    paidCount: number;
    failedCount: number;
  };
}

export interface UtrBatchRow {
  outletId: string;
  utrStatus: 'PENDING' | 'PAID' | 'FAILED';
  utr?: string;
  /**
   * The outlet's bank account number (from the KYC partner). Used for the
   * same-account shared-UTR rule: a repeated UTR is allowed only when every
   * row/entry carrying it is paid from the SAME bank account (a legitimate
   * combined transfer). Missing/blank = account unknown (never counts as a
   * distinct account, so it can neither justify nor trigger a same-account error).
   */
  accountNumber?: string;
}

export interface ParseUtrUploadOpts {
  downloadCode: string;
  batchRows: UtrBatchRow[];
  /**
   * UTRs already used by entries in PRIOR batches, mapped to the set of DISTINCT
   * non-empty bank account numbers those prior entries were paid from. A repeat of
   * one of these UTRs is rejected UNLESS this upload pays the same single account
   * (a combined transfer spanning batches). The re-apply exemption (an entry that
   * already carries this exact UTR) is handled separately in the parser.
   */
  knownUtrs: Map<string, Set<string>>;
}

export function parseUtrUpload(
  buffer: ArrayBufferLike,
  opts: ParseUtrUploadOpts,
): UtrParseResult {
  const { downloadCode, batchRows, knownUtrs } = opts;

  if (!batchRows.length) {
    return {
      headerError: `No payout entries found for download "${downloadCode}".`,
      rows: [],
      hasErrors: false,
      canProceed: false,
      summary: { total: 0, ok: 0, skipped: 0, errors: 0, paidCount: 0, failedCount: 0 },
    };
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'array' });
  } catch {
    return {
      headerError: 'Could not read file. Please upload a valid .xlsx file.',
      rows: [],
      hasErrors: false,
      canProceed: false,
      summary: { total: 0, ok: 0, skipped: 0, errors: 0, paidCount: 0, failedCount: 0 },
    };
  }

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const allRows = XLSX.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: '',
  }) as (string | number)[][];

  if (allRows.length < 2) {
    return {
      headerError: 'File has no header row.',
      rows: [],
      hasErrors: false,
      canProceed: false,
      summary: { total: 0, ok: 0, skipped: 0, errors: 0, paidCount: 0, failedCount: 0 },
    };
  }

  const headers = allRows[1].map((h) => String(h).trim());
  const outletIdIdx = headers.indexOf('Outlet ID');
  const batchIdIdx = headers.indexOf('Batch ID');
  const utrIdx = headers.indexOf('UTR');
  const paymentDateIdx = headers.indexOf('Payment Date');
  const successIdx = headers.indexOf('Success/Failure');
  const remarksIdx = headers.indexOf('Remarks');

  if (outletIdIdx === -1 || utrIdx === -1) {
    return {
      headerError:
        'Missing "Outlet ID" or "UTR" column. Please use the official payout file.',
      rows: [],
      hasErrors: false,
      canProceed: false,
      summary: { total: 0, ok: 0, skipped: 0, errors: 0, paidCount: 0, failedCount: 0 },
    };
  }

  const batchRowMap = new Map(batchRows.map((r) => [r.outletId, r]));
  // Within-file: UTR (uppercase) → set of DISTINCT non-empty bank accounts it has been
  // seen with in THIS upload. A repeat is allowed while the accounts match (combined
  // transfer); a second DISTINCT account for the same UTR is a copy-paste mistake → error.
  const seenUtrAccounts = new Map<string, Set<string>>();
  const rows: UtrUploadRow[] = [];
  let paidCount = 0;
  let failedCount = 0;

  for (let rIdx = 2; rIdx < allRows.length; rIdx++) {
    const row = allRows[rIdx];
    const outletId = String(row[outletIdIdx] ?? '').trim();
    if (!outletId) continue;

    const fileBatchId = batchIdIdx !== -1 ? String(row[batchIdIdx] ?? '').trim() : '';
    const utrRaw = String(row[utrIdx] ?? '').trim();
    const successRaw = successIdx !== -1 ? String(row[successIdx] ?? '').trim() : '';
    const remarksRaw = remarksIdx !== -1 ? String(row[remarksIdx] ?? '').trim() : '';
    // Pass the RAW cell (string | number) so an Excel date serial is parsed, not stringified.
    const paymentDateRaw = paymentDateIdx !== -1 ? row[paymentDateIdx] : '';

    const batchRow = batchRowMap.get(outletId);
    const errors: string[] = [];

    // Payment Date — blank ok; invalid → row error. Applies to paidAt only for paid rows.
    const parsedDate = parsePaymentDateCell(paymentDateRaw as string | number);
    if (parsedDate.error) errors.push(parsedDate.error);

    // Already paid — skip (idempotency)
    if (batchRow?.utrStatus === 'PAID') {
      rows.push({
        rowNum: rIdx + 1,
        outletId,
        batchId: fileBatchId || downloadCode,
        utr: utrRaw,
        success: true,
        remarks: remarksRaw,
        status: 'SKIP',
        errors: [],
      });
      continue;
    }

    if (!batchRow) {
      errors.push(`Outlet ID "${outletId}" not found in batch "${downloadCode}".`);
    }

    if (fileBatchId && fileBatchId !== downloadCode) {
      errors.push(`Batch ID "${fileBatchId}" does not match expected "${downloadCode}".`);
    }

    const success = parseSuccess(successRaw);

    if (success) {
      if (!utrRaw) {
        errors.push('UTR is required for successful payments.');
      } else {
        if (!isValidUtr(utrRaw)) {
          errors.push(
            `UTR "${utrRaw}" is not valid (must be 8–22 alphanumeric characters).`,
          );
        }
        const normUtr = utrRaw.toUpperCase();
        // The outlet's bank account (from DB batch data — the operator cannot spoof it via
        // the file). '' = unknown; an unknown account never counts as a distinct account.
        const acct = (batchRow?.accountNumber ?? '').trim();
        const isReapplyOfThisEntry = batchRow?.utr?.toUpperCase() === normUtr;

        // Cross-batch: a UTR used in a PRIOR batch is allowed ONLY when this upload pays the
        // same single bank account (a combined transfer spanning batches). The re-apply of an
        // entry that already carries this exact UTR is always exempt.
        if (knownUtrs.has(normUtr) && !isReapplyOfThisEntry) {
          const priorAccts = knownUtrs.get(normUtr)!;
          const sameAccount =
            acct.length > 0 &&
            priorAccts.size > 0 &&
            [...priorAccts].every((a) => a === acct);
          if (!sameAccount) {
            errors.push(
              `UTR "${utrRaw}" has already been used in a previous batch under a different bank account.`,
            );
          }
        }

        // Within-file: a repeated UTR is allowed while every occurrence shares one bank
        // account; a second DISTINCT non-empty account for the same UTR is an error.
        const seenAccts = seenUtrAccounts.get(normUtr);
        if (seenAccts) {
          if (acct.length > 0 && [...seenAccts].some((a) => a !== acct)) {
            errors.push(
              `UTR "${utrRaw}" appears more than once in this upload under a different bank account.`,
            );
          }
        } else {
          seenUtrAccounts.set(normUtr, new Set<string>());
        }
        if (acct.length > 0) seenUtrAccounts.get(normUtr)!.add(acct);
      }
    }

    const status: 'OK' | 'ERROR' = errors.length > 0 ? 'ERROR' : 'OK';
    if (status === 'OK') {
      if (success) paidCount++;
      else failedCount++;
    }

    rows.push({
      rowNum: rIdx + 1,
      outletId,
      batchId: fileBatchId || downloadCode,
      utr: utrRaw,
      success,
      remarks: remarksRaw,
      status,
      errors,
      ...(parsedDate.date ? { paymentDate: parsedDate.date } : {}),
    });
  }

  const okCount = rows.filter((r) => r.status === 'OK').length;
  const skipCount = rows.filter((r) => r.status === 'SKIP').length;
  const errCount = rows.filter((r) => r.status === 'ERROR').length;

  return {
    headerError: null,
    rows,
    hasErrors: errCount > 0,
    canProceed: !!(okCount > 0 && errCount === 0),
    summary: {
      total: okCount + errCount,
      ok: okCount,
      skipped: skipCount,
      errors: errCount,
      paidCount,
      failedCount,
    },
  };
}
