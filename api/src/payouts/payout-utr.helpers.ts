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
 *   - PROCESS-FIRST GUARD (when ctx.txnInfo is supplied — the service always does): a PAID row
 *     is accepted only for a transaction that went through batch processing (INITIATED /
 *     PROCESSING). A still-PENDING (unprocessed) transaction is rejected UNLESS the row sets
 *     "Paid outside platform (Y/N)" = Y — the owner's rule that payments made OUTSIDE Gifsy whose
 *     outcome is recorded here must never be blocked. Such a row still needs a valid UTR/reference
 *     and a positive amount; "Off-platform note" is optional free text. Y is only meaningful on a
 *     PAID row (Y on a FAILED row is an error).
 *   - OFF-PLATFORM (Y) rows — "never block recording an outside payment, never create a double
 *     benefit":
 *       · the reference may be any 1–60 chars of letters/digits/space and / - . _ : #
 *         (cheque no., "CASH 12-Nov", "NEFT/HDFC/123"); non-Y rows keep the strict UTR rule;
 *       · a reference may repeat across transactions of the SAME partner (in this upload or in
 *         history) but never across different partners;
 *       · optional "Amount paid (₹)": if filled it must equal the payout amount exactly; blank =
 *         the full amount;
 *       · rejected when the linked redemption was cancelled / its points refunded;
 *       · rejected on a transaction already sent to the bank in a processed batch (INITIATED /
 *         PROCESSING) — only after the bank payment is confirmed failed/returned;
 *       · may not reuse a reference that was used as a genuine bank UTR (non-Y) anywhere.
 *   - REFERENCES are compared NORMALISED (upper-case, all whitespace and / - . _ : # removed) for
 *     duplicate detection; they are stored as typed.
 *   - A row for a transaction that is ALREADY SUCCESS is never silently skipped: it becomes a
 *     notice "Already marked paid on <date> (<off-platform|bank>) — check for a double payment".
 *   - Unknown column headers are listed in `warnings` (ignored, never applied).
 */

/** Duplicate-detection form of a UTR / reference: upper-case, whitespace and / - . _ : # removed. */
export function normaliseRef(ref: string): string {
  return ref.toUpperCase().replace(/[\s/\-._:#]/g, '');
}

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
  'Paid outside platform (Y/N)',
  'Off-platform note',
  'Amount paid (₹)',
] as const;

/** Header of the optional "amount actually paid" column (checked only on off-platform rows). */
export const AMOUNT_PAID_HEADER = 'Amount paid (₹)';
/** Off-platform reference: 1–60 chars of letters, digits, space and / - . _ : # */
const OFF_PLATFORM_REF_RE = /^[A-Za-z0-9 /\-._:#]{1,60}$/;
/** Per-row error when the linked redemption is cancelled/returned/failed or its points refunded. */
export const ORDER_REFUNDED_ERROR =
  "This redemption was cancelled and its points refunded — it can't be marked paid";
/** Per-row error when an off-platform row's "Amount paid (₹)" differs from the payout amount. */
export const AMOUNT_MISMATCH_ERROR = "Amount paid doesn't match the payout amount";

/** Header of the optional "paid outside the platform" flag column (Y/N). */
export const PAID_OFF_PLATFORM_HEADER = 'Paid outside platform (Y/N)';
/** Header of the optional free-text note for an off-platform payment. */
export const OFF_PLATFORM_NOTE_HEADER = 'Off-platform note';
/** PayoutTransaction statuses that have passed batch processing (eligible for PAID). */
export const PROCESSED_PAYOUT_STATUSES = ['INITIATED', 'PROCESSING'] as const;
/** Statuses still awaiting processing — PAID only with "Paid outside platform" = Y. */
export const UNPROCESSED_PAYOUT_STATUSES = ['PENDING', 'HOLD'] as const;
/** Per-row error: "Paid outside platform" = Y on a transaction already sent to the bank. */
export function alreadySentToBankError(batchRef: string): string {
  return `This payment was already sent to the bank in batch ${batchRef}. Only mark it paid outside the platform after the bank payment is confirmed failed/returned.`;
}

/** Per-row notice for a transaction that is already SUCCESS. */
export function alreadyPaidNotice(paidOn: string, offPlatform: boolean): string {
  return `Already marked paid on ${paidOn} (${offPlatform ? 'off-platform' : 'bank'}) — check for a double payment`;
}

/** Per-row error for a PAID row on an unprocessed transaction without the off-platform flag. */
export const NOT_PROCESSED_ERROR =
  "This payment wasn't processed in a batch — process the batch first, or mark it 'Paid outside platform' if it was paid outside Gifsy.";

export type PayoutUtrOutcome = 'PAID' | 'FAILED';

export interface PayoutUtrRow {
  rowNum: number;
  txnId: string;
  outcome: PayoutUtrOutcome | null;
  utr: string;
  status: 'OK' | 'ERROR' | 'SKIP';
  remarks: string;
  errors: string[];
  /** "Paid outside platform (Y/N)" = Y on this row. */
  paidOffPlatform: boolean;
  /** "Off-platform note" free text (blank when not given). */
  offPlatformNote: string;
  /** Set on a row for an already-SUCCESS transaction (status SKIP; never applied). */
  notice?: string;
}

/** Per-transaction context the service supplies to run the guards. */
export interface PayoutUtrTxnInfo {
  status: string;
  amountPaise: bigint | number;
  /** Owner partner — references may repeat only within the same partner (off-platform rows). */
  partnerId?: string;
  /** Linked redemption is CANCELLED/RETURNED/FAILED or its points were refunded. */
  orderRefunded?: boolean;
  /** For a SUCCESS transaction: when it was marked paid (display date) and how. */
  paidOn?: string;
  paidOffPlatform?: boolean;
}

/** One past use of a reference (history), for the off-platform reuse rules. */
export interface KnownRefUse {
  partnerId: string | null;
  /** true = recorded as paid OUTSIDE the platform; false = a genuine bank UTR. */
  offPlatform: boolean;
}

export interface PayoutUtrParseResult {
  headerError: string | null;
  rows: PayoutUtrRow[];
  hasErrors: boolean;
  canProceed: boolean;
  /** Non-blocking notices, e.g. "Ignored columns: …". */
  warnings: string[];
  /** Rows for already-SUCCESS transactions (rowNum + notice) — reported, never applied. */
  alreadyPaid: Array<{ rowNum: number; txnId: string; notice: string }>;
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
  /**
   * Current status + amount of each batch transaction. When supplied, the PROCESS-FIRST guard
   * runs (see the header comment). Omitted → no status guard (pure-parser callers/tests).
   */
  txnInfo?: Map<string, PayoutUtrTxnInfo>;
  /**
   * Upper-cased reference → the partner ids already using it (history). Lets an off-platform row
   * reuse a reference of the SAME partner. Omitted → any history reuse is rejected.
   */
  knownUtrPartners?: Map<string, Set<string>>;
  /**
   * NORMALISED reference → every past use (partner + off-platform?). Supersedes knownUtrPartners
   * when given (the service always passes it).
   */
  knownRefs?: Map<string, KnownRefUse[]>;
  /** Shown in the "already sent to the bank in batch …" error. */
  batchRef?: string;
}

/** "1,500.00" / "₹1500" / "Rs 1,500" / "Rs. 1500" / "INR 1500" / 1500 → paise, or null. */
export function parseRupeesToPaise(raw: string | number): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  const cleaned = raw
    .trim()
    .replace(/^(₹|rs\.?|inr)\s*/i, '')
    .replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

function emptyResult(headerError: string | null): PayoutUtrParseResult {
  return {
    headerError,
    rows: [],
    hasErrors: false,
    canProceed: false,
    warnings: [],
    alreadyPaid: [],
    summary: { total: 0, ok: 0, skipped: 0, errors: 0, paidCount: 0, failedCount: 0 },
  };
}

/** Normalise the "Paid outside platform (Y/N)" cell. Blank/N → false; Y → true; else INVALID. */
function normaliseYesNo(raw: string): boolean | 'INVALID' {
  const v = raw.trim().toUpperCase();
  if (v === '' || v === 'N' || v === 'NO' || v === 'FALSE' || v === '0') return false;
  if (v === 'Y' || v === 'YES' || v === 'TRUE' || v === '1') return true;
  return 'INVALID';
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
  const { batchTxnIds, knownUtrs, txnInfo, knownUtrPartners, knownRefs, batchRef } = ctx;
  const knownNormUtrs = new Set([...knownUtrs].map(normaliseRef));

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
  // Optional off-platform columns (older templates without them → every row is "N").
  const offPlatformIdx = headers.indexOf(PAID_OFF_PLATFORM_HEADER);
  const offNoteIdx = headers.indexOf(OFF_PLATFORM_NOTE_HEADER);
  const amountPaidIdx = headers.indexOf(AMOUNT_PAID_HEADER);

  if (txnIdIdx === -1 || statusIdx === -1) {
    return emptyResult(
      'Missing "Transaction ID" or "Status" column. Please use the official UTR template.',
    );
  }

  // Unknown / typo'd headers are IGNORED — listed so a mistyped "Paid outside platform" column can't
  // silently drop the flag.
  const knownHeaders = new Set<string>([...PAYOUT_UTR_HEADERS, 'Remarks']);
  const ignored = headers.filter((h) => h !== '' && !knownHeaders.has(h));
  const warnings: string[] = ignored.length
    ? [`Ignored columns (not recognised): ${ignored.map((h) => `"${h}"`).join(', ')}`]
    : [];
  const alreadyPaid: PayoutUtrParseResult['alreadyPaid'] = [];

  // Pre-pass: every PAID reference in this upload → the rows using it (Y-ness + partner), so the
  // in-upload duplicate rule is order-independent: a reference may repeat ONLY when every row using
  // it is an off-platform (Y) row of the SAME partner.
  const refUses = new Map<string, Array<{ y: boolean; partnerId: string | undefined }>>();
  for (let rIdx = 1; rIdx < allRows.length; rIdx++) {
    const r = allRows[rIdx];
    const st = normaliseStatus(String(r[statusIdx] ?? ''));
    const ref = utrIdx !== -1 ? normaliseRef(String(r[utrIdx] ?? '').trim()) : '';
    if (st !== 'PAID' || !ref) continue;
    const id = String(r[txnIdIdx] ?? '').trim();
    const y = offPlatformIdx !== -1 && normaliseYesNo(String(r[offPlatformIdx] ?? '')) === true;
    const list = refUses.get(ref) ?? [];
    list.push({ y, partnerId: txnInfo?.get(id)?.partnerId });
    refUses.set(ref, list);
  }

  const seenRefs = new Set<string>();
  const rows: PayoutUtrRow[] = [];
  let paidCount = 0;
  let failedCount = 0;

  for (let rIdx = 1; rIdx < allRows.length; rIdx++) {
    const row = allRows[rIdx];
    const txnId = String(row[txnIdIdx] ?? '').trim();
    const utrRaw = utrIdx !== -1 ? String(row[utrIdx] ?? '').trim() : '';
    const statusRaw = String(row[statusIdx] ?? '').trim();
    const remarksRaw = remarksIdx !== -1 ? String(row[remarksIdx] ?? '').trim() : '';
    const offPlatformRaw = offPlatformIdx !== -1 ? String(row[offPlatformIdx] ?? '').trim() : '';
    const offNoteRaw = offNoteIdx !== -1 ? String(row[offNoteIdx] ?? '').trim() : '';
    const amountPaidRaw = amountPaidIdx !== -1 ? row[amountPaidIdx] ?? '' : '';
    const offPlatform = normaliseYesNo(offPlatformRaw);

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
        paidOffPlatform: offPlatform === true,
        offPlatformNote: offNoteRaw,
      });
      continue;
    }

    // Already SUCCESS → a NOTICE, never applied and never silent (possible double payment).
    const infoEarly = txnId ? txnInfo?.get(txnId) : undefined;
    if (infoEarly?.status === 'SUCCESS' && (outcome === 'PAID' || outcome === 'FAILED')) {
      const notice = alreadyPaidNotice(infoEarly.paidOn ?? 'an earlier date', !!infoEarly.paidOffPlatform);
      alreadyPaid.push({ rowNum: rIdx + 1, txnId, notice });
      rows.push({
        rowNum: rIdx + 1,
        txnId,
        outcome: null,
        utr: utrRaw,
        status: 'SKIP',
        remarks: notice,
        errors: [],
        paidOffPlatform: offPlatform === true,
        offPlatformNote: offNoteRaw,
        notice,
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

    const info = txnId ? txnInfo?.get(txnId) : undefined;

    if (outcome === 'PAID') {
      if (!utrRaw) {
        errors.push('UTR is required for a PAID transaction.');
      } else if (offPlatform === true) {
        // OFF-PLATFORM reference: relaxed format; reuse allowed only within the same partner.
        if (!OFF_PLATFORM_REF_RE.test(utrRaw)) {
          errors.push(
            `Reference "${utrRaw}" is not valid (1–60 characters: letters, digits, space and / - . _ : #).`,
          );
        }
        const normRef = normaliseRef(utrRaw);
        const partnerId = info?.partnerId;
        if (knownRefs) {
          const past = knownRefs.get(normRef) ?? [];
          if (past.some((u) => !u.offPlatform)) {
            errors.push(`Reference "${utrRaw}" was already used as a bank UTR — it can't be reused for an off-platform payment.`);
          } else if (past.some((u) => !partnerId || u.partnerId !== partnerId)) {
            errors.push(`Reference "${utrRaw}" has already been used for a different partner.`);
          }
        } else {
          const historyOwners = knownUtrPartners?.get(normRef);
          const historyConflict = knownUtrPartners
            ? !!historyOwners && (!partnerId || [...historyOwners].some((p) => p !== partnerId))
            : knownNormUtrs.has(normRef);
          if (historyConflict) {
            errors.push(`Reference "${utrRaw}" has already been used for a different partner.`);
          }
        }
        const uses = refUses.get(normRef) ?? [];
        if (uses.length > 1 && !uses.every((u) => u.y && !!partnerId && u.partnerId === partnerId)) {
          errors.push(`Reference "${utrRaw}" appears more than once in this upload for a different partner or a non-off-platform row.`);
        }
      } else {
        if (!isValidUtr(utrRaw)) {
          errors.push(
            `UTR "${utrRaw}" is not valid (must be 8–22 alphanumeric characters).`,
          );
        }
        const normUtr = normaliseRef(utrRaw);
        if (knownNormUtrs.has(normUtr) || (knownRefs?.has(normUtr) ?? false)) {
          errors.push(`UTR "${utrRaw}" has already been used.`);
        }
        // Unchanged rule for non-off-platform rows: the FIRST use in the file is fine, every later
        // use of the same reference (by any row) is a duplicate.
        if (seenRefs.has(normUtr)) {
          errors.push(`UTR "${utrRaw}" appears more than once in this upload.`);
        }
      }
      seenRefs.add(normaliseRef(utrRaw));
    }

    if (offPlatform === 'INVALID') {
      errors.push(`"${PAID_OFF_PLATFORM_HEADER}" must be Y or N (got "${offPlatformRaw}").`);
    } else if (offPlatform === true && outcome === 'FAILED') {
      errors.push(`"${PAID_OFF_PLATFORM_HEADER}" = Y can only be used on a PAID row.`);
    }

    // PROCESS-FIRST guard (service-supplied txnInfo): PAID needs a processed transaction unless
    // the row records an off-platform payment (which must still carry a positive amount).
    if (info && outcome === 'PAID') {
      const processed = (PROCESSED_PAYOUT_STATUSES as readonly string[]).includes(info.status);
      const unprocessed = (UNPROCESSED_PAYOUT_STATUSES as readonly string[]).includes(info.status);
      if (unprocessed && offPlatform !== true) {
        errors.push(NOT_PROCESSED_ERROR);
      }
      // Already sent to the bank in a processed batch — marking it paid outside would risk paying
      // twice. Only after the bank payment is confirmed failed/returned.
      if (processed && offPlatform === true) {
        errors.push(alreadySentToBankError(batchRef ?? 'this batch'));
      }
      if ((processed || unprocessed) && offPlatform === true && !(Number(info.amountPaise) > 0)) {
        errors.push('Cannot record an off-platform payment for a transaction with no valid amount.');
      }
      if (offPlatform === true && info.orderRefunded) {
        errors.push(ORDER_REFUNDED_ERROR);
      }
    }

    // Optional "Amount paid (₹)" — checked ONLY on off-platform rows: if filled it must equal the
    // payout amount exactly (blank = the full amount). Non-Y rows ignore the column.
    if (outcome === 'PAID' && offPlatform === true && String(amountPaidRaw).trim() !== '') {
      const paidPaise = parseRupeesToPaise(amountPaidRaw as string | number);
      if (paidPaise === null || !info || paidPaise !== Number(info.amountPaise)) {
        errors.push(AMOUNT_MISMATCH_ERROR);
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
      paidOffPlatform: offPlatform === true,
      offPlatformNote: offNoteRaw,
    });
  }

  const okCount = rows.filter((r) => r.status === 'OK').length;
  const skipCount = rows.filter((r) => r.status === 'SKIP').length;
  const errCount = rows.filter((r) => r.status === 'ERROR').length;

  return {
    headerError: null,
    rows,
    hasErrors: errCount > 0,
    // An upload whose only rows are "already paid" notices still proceeds (a no-op re-upload stays
    // idempotent) — the notices are returned in the result, never swallowed.
    canProceed: (okCount > 0 || alreadyPaid.length > 0) && errCount === 0,
    warnings,
    alreadyPaid,
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
