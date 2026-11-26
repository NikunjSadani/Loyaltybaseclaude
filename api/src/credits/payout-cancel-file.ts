/**
 * "Cancel payouts — upload file" (owner 2026-11-25): the downloadable template (pre-filled from the screen's filter)
 * and the parser for the filled-in file. PURE (no DB) — the service evaluates the parsed rows with the same rules as
 * the on-screen cancel (payout-cancel.ts). Writing goes through the formula-safe builder (common/xlsx buildXlsx);
 * reading never evaluates formulas.
 */
import * as XLSX from 'xlsx';
import { buildXlsx } from '../common/xlsx';
import { CANCEL_REASON_MAX, type CancelRowView } from './payout-cancel';

export const COL = {
  entryId: 'Entry ID',
  upload: 'Upload code',
  outletId: 'Outlet ID',
  outletName: 'Outlet name',
  field: 'Field',
  period: 'Period',
  amount: 'Amount (₹)',
  status: 'Status',
  bankFile: 'Bank file',
  failureReason: 'Failure reason',
  cancel: 'Cancel? (Y)',
  reason: 'Reason',
} as const;

/** Status words in the file: the exact stored status (stable to parse back). */
export const FILE_STATUS = { PENDING: 'PENDING', FAILED: 'FAILED' } as const;

export function buildCancelTemplate(rows: CancelRowView[], scopeNote: string): Buffer {
  return buildXlsx([
    {
      name: 'Payouts',
      rows:
        rows.length > 0
          ? rows.map((r) => ({
              [COL.entryId]: r.entryId,
              [COL.upload]: r.batchCode,
              [COL.outletId]: r.outletId,
              [COL.outletName]: r.outletName,
              [COL.field]: r.fieldName,
              [COL.period]: r.period,
              [COL.amount]: r.amountPaise / 100,
              [COL.status]: r.status,
              [COL.bankFile]: r.downloadCode ?? '',
              [COL.failureReason]: r.failureReason ?? '',
              [COL.cancel]: '',
              [COL.reason]: '',
            }))
          : [Object.fromEntries(Object.values(COL).map((c) => [c, '']))],
    },
    {
      name: 'How to use',
      rows: [
        { Step: '1', Instruction: `This file lists ${rows.length} payout row(s) that could be cancelled — ${scopeNote}.` },
        { Step: '2', Instruction: 'Put Y in "Cancel? (Y)" for each row to cancel. Leave it blank to keep the row.' },
        { Step: '3', Instruction: 'Give a reason per row in "Reason", or type one reason for the whole file on the upload screen.' },
        { Step: '4', Instruction: 'Do not change Entry ID, Amount or Status — a row whose amount or status changed since the file was made is refused.' },
        { Step: '5', Instruction: 'PENDING = never sent to the bank (cancel unpaid). FAILED = the bank rejected it (cancel failed — it will not be re-banked).' },
        { Step: '6', Instruction: 'Upload the file: you see a preview of exactly what will be cancelled and every row that cannot be, before anything changes.' },
      ],
    },
  ]);
}

export interface ParsedCancelRow {
  rowNum: number;
  entryId: string;
  expectedStatus: 'PENDING' | 'FAILED';
  expectedAmountPaise: bigint;
  reason: string;
  /** What the file said about the row (for the preview / audit). */
  outletId: string;
  outletName: string;
  upload: string;
}

export interface FileProblem {
  rowNum: number;
  entryId: string;
  outletId: string;
  reason: string;
}

export interface ParsedCancelFile {
  headerError: string | null;
  rows: ParsedCancelRow[];
  problems: FileProblem[];
  /** Rows present in the file but not marked Y (kept — listed as a count, never cancelled). */
  notMarked: number;
}

const s = (v: unknown) => (v == null ? '' : String(v)).trim();

export function parseCancelFile(buffer: ArrayBufferLike | Buffer, fileReason: string | null): ParsedCancelFile {
  const empty = (headerError: string): ParsedCancelFile => ({ headerError, rows: [], problems: [], notMarked: 0 });
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: Buffer.isBuffer(buffer) ? 'buffer' : 'array', cellFormula: false });
  } catch {
    return empty('Could not read the file. Upload the .xlsx template downloaded from this screen.');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return empty('The file has no sheet.');
  const all = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: true }) as unknown[][];
  if (all.length < 1) return empty('The file is empty.');
  const header = all[0].map((h) => s(h));
  const idx = (c: string) => header.indexOf(c);
  const need = [COL.entryId, COL.amount, COL.status, COL.cancel];
  const missing = need.filter((c) => idx(c) < 0);
  if (missing.length > 0) return empty(`Missing column(s): ${missing.join(', ')}. Use the template downloaded from this screen.`);
  const iId = idx(COL.entryId), iAmt = idx(COL.amount), iSt = idx(COL.status), iCan = idx(COL.cancel);
  const iReason = idx(COL.reason), iOutlet = idx(COL.outletId), iName = idx(COL.outletName), iUp = idx(COL.upload);

  const out: ParsedCancelFile = { headerError: null, rows: [], problems: [], notMarked: 0 };
  for (let r = 1; r < all.length; r++) {
    const row = all[r];
    if (!row || row.every((c) => s(c) === '')) continue;
    const rowNum = r + 1;
    const entryId = s(row[iId]);
    const outletId = iOutlet >= 0 ? s(row[iOutlet]) : '';
    const mark = s(row[iCan]).toUpperCase();
    if (mark === '') { out.notMarked++; continue; }
    const problem = (reason: string) => out.problems.push({ rowNum, entryId, outletId, reason });
    if (mark !== 'Y' && mark !== 'YES') { problem(`"Cancel? (Y)" must be Y or blank (found "${s(row[iCan])}")`); continue; }
    if (!entryId) { problem('Entry ID is blank'); continue; }
    const st = s(row[iSt]).toUpperCase();
    if (st !== FILE_STATUS.PENDING && st !== FILE_STATUS.FAILED) {
      problem(`Status must be PENDING or FAILED (found "${s(row[iSt])}") — only unpaid or failed payouts can be cancelled`);
      continue;
    }
    const rawAmt = row[iAmt];
    const amt = typeof rawAmt === 'number' ? rawAmt : Number(s(rawAmt).replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(amt) || amt <= 0) { problem(`Amount is not a valid rupee amount (found "${s(rawAmt)}")`); continue; }
    const rowReason = iReason >= 0 ? s(row[iReason]) : '';
    const reason = rowReason || (fileReason ?? '').trim();
    if (!reason) { problem('No reason — fill "Reason" for this row or give one reason for the whole file'); continue; }
    if (reason.length > CANCEL_REASON_MAX) { problem(`Reason is too long (max ${CANCEL_REASON_MAX} characters)`); continue; }
    out.rows.push({
      rowNum,
      entryId,
      expectedStatus: st as 'PENDING' | 'FAILED',
      expectedAmountPaise: BigInt(Math.round(amt * 100)),
      reason,
      outletId,
      outletName: iName >= 0 ? s(row[iName]) : '',
      upload: iUp >= 0 ? s(row[iUp]) : '',
    });
  }
  return out;
}
