import * as XLSX from 'xlsx';

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
      '',
      '',
      '',
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);
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
}

export interface ParseUtrUploadOpts {
  downloadCode: string;
  batchRows: UtrBatchRow[];
  knownUtrs: Set<string>;
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
  const seenUtrs = new Set<string>();
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

    const batchRow = batchRowMap.get(outletId);
    const errors: string[] = [];

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
        if (knownUtrs.has(normUtr) && !(batchRow?.utr?.toUpperCase() === normUtr)) {
          errors.push(`UTR "${utrRaw}" has already been used in a previous batch.`);
        }
        if (seenUtrs.has(normUtr)) {
          errors.push(`UTR "${utrRaw}" appears more than once in this upload.`);
        } else if (errors.length === 0) {
          seenUtrs.add(normUtr);
        }
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
