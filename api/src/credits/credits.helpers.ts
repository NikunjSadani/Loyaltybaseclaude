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

export type PaymentOutcome = 'SUCCESS' | 'FAILURE' | 'INVALID';

// Tokens an operator may type in the "Success/Failure" column, matched
// case-insensitively on the trimmed cell. "PAID" is included because the UI
// labels a paid row PAID everywhere, so an operator naturally types "Paid".
// "P" is deliberately EXCLUDED — it is ambiguous (Paid vs Pending); a bare "P"
// falls through to INVALID so it is flagged, never silently treated as paid.
const SUCCESS_TOKENS = new Set([
  'SUCCESS',
  'PAID',
  'YES',
  'Y',
  '1',
  'TRUE',
  'T',
]);
const FAILURE_TOKENS = new Set([
  'FAILED',
  'FAILURE',
  'FAIL',
  'NO',
  'N',
  '0',
  'FALSE',
  'F',
  'REJECTED',
  'BOUNCED',
  'RETURNED',
]);

/**
 * Classify the "Success/Failure" cell of a payout UTR-upload row into a 3-state
 * outcome. Matched case-insensitively on the trimmed cell.
 *
 *   - SUCCESS → the operator marked the payout paid. The caller STILL requires a
 *     valid UTR before treating the entry as PAID.
 *   - FAILURE → the operator legitimately marked the payout failed (e.g. a bank
 *     bounce). The caller marks the entry FAILED.
 *   - INVALID → an unrecognized value OR a blank cell. This is NOT a failure: the
 *     caller flags the row as an ERROR (so it is not applied and the entry stays
 *     PROCESSING / re-uploadable) rather than silently marking it FAILED.
 *
 * (Replaces the old boolean `parseSuccess`, whose "anything not in the success
 * list → failure" behaviour silently marked a row typed "Paid" as a FAILED
 * payout — money lost from the wallet with no visible error.)
 */
export function classifyPaymentOutcome(
  raw: string | number | null | undefined,
): PaymentOutcome {
  const v = String(raw ?? '')
    .trim()
    .toUpperCase();
  if (!v) return 'INVALID';
  if (SUCCESS_TOKENS.has(v)) return 'SUCCESS';
  if (FAILURE_TOKENS.has(v)) return 'FAILURE';
  return 'INVALID';
}

export interface UtrUploadRow {
  rowNum: number;
  outletId: string;
  batchId: string;
  utr: string;
  /**
   * Whether this row is a PAID row. Only meaningful for `status: 'OK'` (and the
   * idempotent `'SKIP'`: true = entry already PAID, false = entry already FAILED) — for an `'ERROR'` row
   * (unrecognized/blank Success/Failure, missing UTR, etc.) it is NOT load-bearing
   * and the row must not be applied.
   */
  success: boolean;
  remarks: string;
  status: 'OK' | 'ERROR' | 'SKIP';
  errors: string[];
  /**
   * Parsed "Payment Date" for this row, when the operator filled the cell. Drives
   * the entry's paidAt on apply (else apply-time). Undefined = blank cell.
   */
  paymentDate?: Date;
  /**
   * Informational, non-blocking. SKIP rows: why nothing changes (already paid / already failed /
   * paid-but-file-says-failed / paid-with-a-different-UTR). OK rows: a healing row whose UTR differs
   * from the one already recorded on part of the outlet's payout.
   */
  notice?: string;
}

/** The two notices that mean "genuinely already applied" (the file repeats the recorded outcome). */
export const UTR_NOTICE_ALREADY_PAID = 'Already paid — no change.';
export const UTR_NOTICE_ALREADY_FAILED = 'Already marked failed — no change.';
// NB: deliberately NOT "raise a reversal" — a credits reversal on a PAID entry books a RECEIVABLE
// (claws the cash back), which is wrong for a bank return where the money already came back.
export const UTR_NOTICE_PAID_BUT_FAILED_ROW =
  "Already marked PAID — no change. If the bank returned this payment, don't raise a reversal — contact Gifsy ops to correct it.";
/**
 * What became of an outlet recorded on this download (bankSnapshots) that no longer has an entry
 * in it — classified from the DB, never assumed from the snapshot (which is built BEFORE the
 * held/payable split, so it also lists outlets HELD at download time that never went to the bank).
 *   REBANKED = its entry now sits in a LATER download · REVERSED = clawed back (downloadId null)
 *   HELD = still PENDING with no download (held at download time — never in this bank file)
 */
export type FormerOutletFate = 'REBANKED' | 'REVERSED' | 'HELD';
export const UTR_NOTICE_REBANKED = 'Re-banked in a later payout file — no change.';
export const UTR_NOTICE_REVERSED = 'Reversed — no change.';
export const UTR_ERROR_HELD_AT_DOWNLOAD =
  'This outlet was held at download (e.g. KYC) — it was not in this bank file. Remove this row; if it was paid by hand, contact Gifsy ops before it is released.';
export const UTR_ERROR_REBANKED_SUCCESS =
  'This payout was re-banked in a later file and may be paid again — remove this row and contact Gifsy ops.';
export const UTR_ERROR_REVERSED_SUCCESS =
  "This payout was reversed — it can't be marked paid from this file. Remove this row and contact Gifsy ops.";

export interface UtrParseResult {
  headerError: string | null;
  rows: UtrUploadRow[];
  hasErrors: boolean;
  canProceed: boolean;
  /**
   * True when the file is valid but EVERY row is an idempotent SKIP (all already applied):
   * applying it is a no-op (nothing written, nothing sent). Mirrors the payouts module, where an
   * all-notice re-upload still proceeds (src/payouts/payout-utr.helpers.ts) instead of erroring.
   */
  noop: boolean;
  summary: {
    total: number;
    ok: number;
    skipped: number;
    errors: number;
    paidCount: number;
    failedCount: number;
  };
}

/**
 * Collapse a download's payout entries into ONE UTR batch row per outlet. A download can hold
 * several entries for the same outlet (one per payout row at confirm) that were summed into ONE
 * bank line, so a UTR file row speaks for the whole group. Group state (REVERSED entries ignored
 * unless they are all there is):
 *   any entry still PENDING/PROCESSING → 'PENDING' (the row applies to those entries)
 *   all PAID → 'PAID' · all FAILED → 'FAILED' · all REVERSED → 'REVERSED'
 *   settled but PAID + FAILED mixed → 'MIXED' (cannot be resolved from one bank line → ERROR)
 * `utr` = the first recorded UTR among the group's PAID entries (re-apply exemption).
 * `settled` = the outcome already recorded on the group's SETTLED siblings (PAID / FAILED / MIXED,
 * null when none) — so a 'PENDING' group that is partly settled still rejects a row contradicting
 * what one bank line already recorded (e.g. FAILED sibling + Success row → paid twice on re-bank).
 */
export function groupUtrBatchRows(
  entries: ReadonlyArray<{ outletId: string; status: string; utr?: string | null }>,
): Array<{ outletId: string; utrStatus: UtrBatchRow['utrStatus']; utr?: string; settled: UtrBatchRow['settled'] }> {
  const byOutlet = new Map<string, Array<{ status: string; utr?: string | null }>>();
  for (const e of entries) {
    const list = byOutlet.get(e.outletId);
    if (list) list.push(e);
    else byOutlet.set(e.outletId, [e]);
  }
  return [...byOutlet.entries()].map(([outletId, group]) => {
    const live = group.filter((e) => e.status !== 'REVERSED');
    let utrStatus: UtrBatchRow['utrStatus'];
    if (live.length === 0) utrStatus = 'REVERSED';
    else if (live.some((e) => e.status !== 'PAID' && e.status !== 'FAILED')) utrStatus = 'PENDING';
    else if (live.every((e) => e.status === 'PAID')) utrStatus = 'PAID';
    else if (live.every((e) => e.status === 'FAILED')) utrStatus = 'FAILED';
    else utrStatus = 'MIXED';
    const hasPaid = live.some((e) => e.status === 'PAID');
    const hasFailed = live.some((e) => e.status === 'FAILED');
    const settled: UtrBatchRow['settled'] =
      hasPaid && hasFailed ? 'MIXED' : hasPaid ? 'PAID' : hasFailed ? 'FAILED' : null;
    const utr = group.find((e) => e.status === 'PAID' && e.utr)?.utr ?? undefined;
    return { outletId, utrStatus, settled, ...(utr ? { utr } : {}) };
  });
}

export interface UtrBatchRow {
  outletId: string;
  /**
   * The outlet's recorded outcome across ALL its entries in this download (see groupUtrBatchRows).
   * REVERSED = clawed back; MIXED = settled partly PAID / partly FAILED. Neither can be applied.
   */
  utrStatus: 'PENDING' | 'PAID' | 'FAILED' | 'REVERSED' | 'MIXED';
  /** Outcome already recorded on the outlet's settled entries (see groupUtrBatchRows); absent = none. */
  settled?: 'PAID' | 'FAILED' | 'MIXED' | null;
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
  /**
   * Outlets recorded on this download at download time (its bankSnapshots) that no longer have any
   * entry in it, with their DB-classified fate (see FormerOutletFate). HELD → blocking ERROR;
   * REBANKED / REVERSED + Failed row → non-blocking notice; + any other row → blocking ERROR (a
   * Success row would let the later file pay it again). An outlet absent from both the entries and
   * this map stays a "not found" ERROR. Optional (absent = none).
   */
  formerOutlets?: Map<string, FormerOutletFate>;
}

export function parseUtrUpload(
  buffer: ArrayBufferLike,
  opts: ParseUtrUploadOpts,
): UtrParseResult {
  const { downloadCode, batchRows, knownUtrs, formerOutlets } = opts;

  // Every entry may have moved out (re-banked / reversed) — still parse so those rows get their
  // per-row notice / error instead of a blocking header error.
  if (!batchRows.length && !formerOutlets?.size) {
    return {
      headerError: `No payout entries found for download "${downloadCode}".`,
      rows: [],
      hasErrors: false,
      canProceed: false,
      noop: false,
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
      noop: false,
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
      noop: false,
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
      noop: false,
      summary: { total: 0, ok: 0, skipped: 0, errors: 0, paidCount: 0, failedCount: 0 },
    };
  }

  const batchRowMap = new Map(batchRows.map((r) => [r.outletId, r]));
  // Within-file: UTR (uppercase) → set of DISTINCT non-empty bank accounts it has been
  // seen with in THIS upload. A repeat is allowed while the accounts match (combined
  // transfer); a second DISTINCT account for the same UTR is a copy-paste mistake → error.
  const seenUtrAccounts = new Map<string, Set<string>>();
  const seenOutlets = new Set<string>();
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

    // 3-state classification. INVALID (unrecognized OR blank) is a clear ERROR,
    // never a silent FAILURE — so the row is not applied and the entry stays
    // PROCESSING / re-uploadable instead of being wrongly marked FAILED.
    const outcome = classifyPaymentOutcome(successRaw);
    const success = outcome === 'SUCCESS';

    // One row per outlet per file. A second row for the same outlet (e.g. "Failed" then "Success")
    // is ambiguous — which outcome is true? — so it is an ERROR (the whole apply is blocked), never
    // silently resolved by whichever row the guarded flip happens to hit first.
    const isDuplicateOutlet = seenOutlets.has(outletId);
    seenOutlets.add(outletId);
    if (isDuplicateOutlet) {
      rows.push({
        rowNum: rIdx + 1,
        outletId,
        batchId: fileBatchId || downloadCode,
        utr: utrRaw,
        success,
        remarks: remarksRaw,
        status: 'ERROR',
        errors: [`Outlet ID "${outletId}" appears more than once in this upload. Keep one row per outlet.`],
      });
      continue;
    }

    // Fully-settled outlet → idempotent SKIP with a notice (mirrors the payouts module's re-upload
    // notices, payout-utr.helpers.ts). PAID ← Success = genuinely already applied (notice names a
    // differing UTR); PAID ← Failed = NON-blocking notice (a bounce after payment is a reversal, not a
    // UTR-file change); FAILED ← Failed = genuinely already applied. FAILED ← Success stays an ERROR
    // below (skipping it would claim a payment that never happened; the entry is re-bankable).
    const recordedUtr = (batchRow?.utr ?? '').trim();
    const utrDiffers =
      !!utrRaw && !!recordedUtr && recordedUtr.toUpperCase() !== utrRaw.toUpperCase();
    let skipNotice: string | null = null;
    if (batchRow?.utrStatus === 'PAID' && outcome === 'SUCCESS') {
      skipNotice = utrDiffers
        ? `Already paid with UTR ${recordedUtr} — no change (file has ${utrRaw}).`
        : UTR_NOTICE_ALREADY_PAID;
    } else if (batchRow?.utrStatus === 'PAID' && outcome === 'FAILURE') {
      skipNotice = UTR_NOTICE_PAID_BUT_FAILED_ROW;
    } else if (batchRow?.utrStatus === 'FAILED' && outcome === 'FAILURE') {
      skipNotice = UTR_NOTICE_ALREADY_FAILED;
    }
    if (skipNotice) {
      rows.push({
        rowNum: rIdx + 1,
        outletId,
        batchId: fileBatchId || downloadCode,
        utr: utrRaw,
        success,
        remarks: remarksRaw,
        status: 'SKIP',
        errors: [],
        notice: skipNotice,
      });
      continue;
    }
    if (batchRow?.utrStatus === 'MIXED' || (batchRow?.utrStatus === 'PENDING' && batchRow.settled === 'MIXED')) {
      errors.push(
        'This outlet\'s payout is already partly PAID and partly FAILED — one bank line can\'t settle both. Remove this row and contact support.',
      );
    }
    // Partly-settled outlet (some entries already settled, the rest still PROCESSING): the row must
    // AGREE with the outcome already recorded on that one bank line. A consistent row heals the rest.
    if (batchRow?.utrStatus === 'PENDING' && batchRow.settled === 'FAILED' && outcome === 'SUCCESS') {
      errors.push(
        'This outlet\'s payout is already partly marked FAILED — this Success row would mark the rest PAID while the failed part is re-banked (paid twice). Remove this row and contact support, or re-bank the failed part.',
      );
    }
    if (batchRow?.utrStatus === 'PENDING' && batchRow.settled === 'PAID' && outcome === 'FAILURE') {
      errors.push(
        'This outlet\'s payout is already partly marked PAID — this Failed row would mark the rest FAILED, but one bank line can\'t be both. Remove this row and contact support.',
      );
    }
    const healNotice =
      batchRow?.utrStatus === 'PENDING' && batchRow.settled === 'PAID' && outcome === 'SUCCESS' && utrDiffers
        ? `Part of this outlet's payout was already paid with UTR ${recordedUtr}; the rest will be recorded with ${utrRaw}.`
        : null;
    if (batchRow?.utrStatus === 'FAILED' && outcome === 'SUCCESS') {
      errors.push(
        "This payout is marked FAILED and will be re-banked in the next payout file. If it was actually paid, remove this row and contact Gifsy ops before the next payout file — don't re-bank it.",
      );
    }
    // DEFENSIVE / unreachable today: an approved reversal sets the entry's downloadId to null, so a
    // REVERSED entry never appears among a download's entries (that outlet is classified via
    // formerOutlets below instead). Kept for legacy rows only.
    if (batchRow?.utrStatus === 'REVERSED') {
      errors.push('Entry has been reversed — it can\'t be paid or failed from this file. Remove this row.');
    }

    // An outlet recorded on this download whose entries have since left it. Only a FAILED row on a
    // genuinely re-banked / reversed payout is a non-blocking notice (so a re-upload of the original
    // file isn't blocked). A held outlet was never in this bank file, and a Success row on a
    // re-banked / reversed one would let it be paid again → blocking ERROR.
    const fate = !batchRow ? formerOutlets?.get(outletId) : undefined;
    if (fate) {
      const formerNotice =
        fate !== 'HELD' && outcome === 'FAILURE'
          ? fate === 'REBANKED' ? UTR_NOTICE_REBANKED : UTR_NOTICE_REVERSED
          : null;
      const formerError = formerNotice
        ? null
        : fate === 'HELD'
          ? UTR_ERROR_HELD_AT_DOWNLOAD
          : fate === 'REBANKED' ? UTR_ERROR_REBANKED_SUCCESS : UTR_ERROR_REVERSED_SUCCESS;
      rows.push({
        rowNum: rIdx + 1,
        outletId,
        batchId: fileBatchId || downloadCode,
        utr: utrRaw,
        success,
        remarks: remarksRaw,
        status: formerNotice ? 'SKIP' : 'ERROR',
        errors: formerError ? [formerError] : [],
        ...(formerNotice ? { notice: formerNotice } : {}),
      });
      continue;
    }

    if (!batchRow) {
      errors.push(`Outlet ID "${outletId}" not found in batch "${downloadCode}".`);
    }

    if (fileBatchId && fileBatchId !== downloadCode) {
      errors.push(`Batch ID "${fileBatchId}" does not match expected "${downloadCode}".`);
    }

    if (outcome === 'INVALID') {
      errors.push(
        successRaw
          ? `Success/Failure value "${successRaw}" is not recognized. Use Success/Paid/Yes for a paid row, or Failed/No for a failed one.`
          : 'Success/Failure is blank. Enter Success/Paid for a paid row, or Failed/No for a failed one.',
      );
    }

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
      ...(status === 'OK' && healNotice ? { notice: healNotice } : {}),
    });
  }

  const okCount = rows.filter((r) => r.status === 'OK').length;
  const skipCount = rows.filter((r) => r.status === 'SKIP').length;
  const errCount = rows.filter((r) => r.status === 'ERROR').length;

  return {
    headerError: null,
    rows,
    hasErrors: errCount > 0,
    // An upload whose only rows are already-applied SKIPs still proceeds (a re-upload of an applied
    // file is an idempotent no-op, not an error) — mirrors src/payouts/payout-utr.helpers.ts. Any
    // ERROR row still blocks the whole apply exactly as before.
    canProceed: (okCount > 0 || skipCount > 0) && errCount === 0,
    noop: okCount === 0 && skipCount > 0 && errCount === 0,
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
