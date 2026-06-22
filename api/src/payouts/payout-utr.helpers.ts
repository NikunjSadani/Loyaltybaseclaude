import * as XLSX from 'xlsx';

/**
 * Payout UTR upload — pure helpers (no Nest / no Prisma), mirroring the credits
 * UTR parser (src/credits/credits.helpers.ts → parseUtrUpload). GIFSY uploads a
 * filled UTR/status report against a PROCESSING payout batch; this parses it into
 * a preview the service can apply.
 *
 * Difference from the credits parser: the stable per-row key here is the
 * PayoutTransaction id ("Transaction ID"), not an outlet code, and the outcome is
 * an explicit Status of PAID / FAILED (a redemption either DELIVERED on PAID or
 * FAILED + points-reversed on FAILED). The shape/labels otherwise match the
 * credits parser for consistency.
 *
 * Validation per row:
 *   - Transaction ID must be present AND a member of ctx.batchTxnIds (else reject).
 *   - Status must be PAID or FAILED (case-insensitive). Blank / SKIP → skipped.
 *   - A PAID row MUST carry a non-empty, structurally-valid UTR.
 *   - A PAID row's UTR must not collide with ctx.knownUtrs (a UTR already used by
 *     any payout transaction for this client) NOR appear twice in this upload.
 *   - A FAILED row needs no UTR; remarks/reason are captured for failureReason.
 */

const UTR_RE = /^[A-Z0-9]{8,22}$/i;

export function isValidUtr(utr: string): boolean {
  return UTR_RE.test(utr.trim());
}

// Reference list of the template's columns. The parser locates columns by header
// NAME (indexOf), not position, and only requires "Transaction ID" + "Status"
// (reading "UTR"/"Remarks" if present) — so the read-only beneficiary columns
// below are ignored on re-upload and never break the round-trip.
export const PAYOUT_UTR_HEADERS = [
  'Transaction ID',
  'Partner Name',
  'PAN',
  'Amount (₹)',
  'Mode',
  'Beneficiary Name',
  'Bank Account Number',
  'IFSC',
  'Bank Name',
  'UPI ID',
  'UTR',
  'Status',
] as const;

export type PayoutUtrOutcome = 'PAID' | 'FAILED';

export interface PayoutUtrRow {
  rowNum: number;
  txnId: string;
  outcome: PayoutUtrOutcome | null;
  utr: string;
  status: 'OK' | 'ERROR' | 'SKIP';
  remarks: string;
  errors: string[];
}

export interface PayoutUtrParseResult {
  headerError: string | null;
  rows: PayoutUtrRow[];
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

export interface ParsePayoutUtrCtx {
  /** Every PayoutTransaction id that belongs to THIS batch (the valid key set). */
  batchTxnIds: Set<string>;
  /** Upper-cased UTRs already used by any of this client's payout transactions. */
  knownUtrs: Set<string>;
}

function emptyResult(headerError: string | null): PayoutUtrParseResult {
  return {
    headerError,
    rows: [],
    hasErrors: false,
    canProceed: false,
    summary: { total: 0, ok: 0, skipped: 0, errors: 0, paidCount: 0, failedCount: 0 },
  };
}

/** Normalise a Status cell. Blank or "SKIP" → SKIP; PAID/FAILED synonyms map; else INVALID. */
function normaliseStatus(raw: string): PayoutUtrOutcome | 'SKIP' | 'INVALID' {
  const v = raw.trim().toUpperCase();
  if (v === '' || v === 'SKIP') return 'SKIP';
  if (v === 'PAID' || v === 'SUCCESS') return 'PAID';
  if (v === 'FAILED' || v === 'FAILURE' || v === 'FAIL') return 'FAILED';
  return 'INVALID';
}

export function parsePayoutUtrUpload(
  buffer: ArrayBufferLike,
  ctx: ParsePayoutUtrCtx,
): PayoutUtrParseResult {
  const { batchTxnIds, knownUtrs } = ctx;

  if (batchTxnIds.size === 0) {
    return emptyResult('No payout transactions found in this batch.');
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'array' });
  } catch {
    return emptyResult('Could not read file. Please upload a valid .xlsx file.');
  }

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) return emptyResult('File has no worksheet.');

  const allRows = XLSX.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: '',
  }) as (string | number)[][];

  // Row 0 = header (the template has a single header row, unlike the credits file
  // which carries a title row above the headers).
  if (allRows.length < 1) return emptyResult('File has no header row.');

  const headers = allRows[0].map((h) => String(h).trim());
  const txnIdIdx = headers.indexOf('Transaction ID');
  const utrIdx = headers.indexOf('UTR');
  const statusIdx = headers.indexOf('Status');
  // Remarks is optional in the template; failureReason falls back to Status text.
  const remarksIdx = headers.indexOf('Remarks');

  if (txnIdIdx === -1 || statusIdx === -1) {
    return emptyResult(
      'Missing "Transaction ID" or "Status" column. Please use the official UTR template.',
    );
  }

  const seenUtrs = new Set<string>();
  const rows: PayoutUtrRow[] = [];
  let paidCount = 0;
  let failedCount = 0;

  for (let rIdx = 1; rIdx < allRows.length; rIdx++) {
    const row = allRows[rIdx];
    const txnId = String(row[txnIdIdx] ?? '').trim();
    const utrRaw = utrIdx !== -1 ? String(row[utrIdx] ?? '').trim() : '';
    const statusRaw = String(row[statusIdx] ?? '').trim();
    const remarksRaw = remarksIdx !== -1 ? String(row[remarksIdx] ?? '').trim() : '';

    // Fully blank line → ignore entirely (not even counted).
    if (!txnId && !statusRaw && !utrRaw) continue;

    const outcome = normaliseStatus(statusRaw);

    // Blank/SKIP status → skip this row (no-op). Mirrors the credits "already paid →
    // SKIP" idempotency rows: counted as skipped, never applied.
    if (outcome === 'SKIP') {
      rows.push({
        rowNum: rIdx + 1,
        txnId,
        outcome: null,
        utr: utrRaw,
        status: 'SKIP',
        remarks: remarksRaw,
        errors: [],
      });
      continue;
    }

    const errors: string[] = [];

    if (!txnId) {
      errors.push('Transaction ID is required.');
    } else if (!batchTxnIds.has(txnId)) {
      errors.push(`Transaction ID "${txnId}" is not part of this batch.`);
    }

    if (outcome === 'INVALID') {
      errors.push(`Status must be PAID or FAILED (got "${statusRaw}").`);
    }

    if (outcome === 'PAID') {
      if (!utrRaw) {
        errors.push('UTR is required for a PAID transaction.');
      } else {
        if (!isValidUtr(utrRaw)) {
          errors.push(
            `UTR "${utrRaw}" is not valid (must be 8–22 alphanumeric characters).`,
          );
        }
        const normUtr = utrRaw.toUpperCase();
        if (knownUtrs.has(normUtr)) {
          errors.push(`UTR "${utrRaw}" has already been used.`);
        }
        if (seenUtrs.has(normUtr)) {
          errors.push(`UTR "${utrRaw}" appears more than once in this upload.`);
        } else if (errors.length === 0) {
          seenUtrs.add(normUtr);
        }
      }
    }

    const finalOutcome: PayoutUtrOutcome | null =
      outcome === 'PAID' || outcome === 'FAILED' ? outcome : null;
    const status: 'OK' | 'ERROR' = errors.length > 0 ? 'ERROR' : 'OK';

    if (status === 'OK') {
      if (finalOutcome === 'PAID') paidCount++;
      else if (finalOutcome === 'FAILED') failedCount++;
    }

    rows.push({
      rowNum: rIdx + 1,
      txnId,
      outcome: finalOutcome,
      utr: utrRaw,
      status,
      // Surface the validation reason on a rejected row so the admin can fix and
      // re-upload; OK/SKIP rows keep any free-text remarks from the file.
      remarks: errors.length > 0 ? errors.join(' ') : remarksRaw,
      errors,
    });
  }

  const okCount = rows.filter((r) => r.status === 'OK').length;
  const skipCount = rows.filter((r) => r.status === 'SKIP').length;
  const errCount = rows.filter((r) => r.status === 'ERROR').length;

  return {
    headerError: null,
    rows,
    hasErrors: errCount > 0,
    canProceed: okCount > 0 && errCount === 0,
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
