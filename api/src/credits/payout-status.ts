/**
 * Payout Status clarity (owner 2026-11-25): per upload AND per field line — how much is paid, in a bank file, pending,
 * failed, reversed and cancelled (amounts + counts), points shown apart (credited points, not money). PURE: the
 * service loads the rows; everything here is deterministic and unit-tested.
 *
 * Reconciliation (no silent gap):
 *  - Σ buckets === Σ payout rows created for the upload (`entriesTotal`), always (every status has a bucket; an
 *    unknown status lands in `other` and is reported);
 *  - `uploadTotal` (the upload's own header total) vs `entriesTotal`: any difference is shown as a note;
 *  - `fund`: the SAME rows classified by Fund Reconciliation's own rule (fund-sources.loader creditItem) — committed /
 *    paid / returned face values — so the two screens agree for these rows (vendor-imported history is excluded from
 *    Fund Reconciliation and says so).
 */
import { creditItem, type CreditEntryRow } from '../fund/fund-sources.loader';

export const STATUS_BUCKETS = ['PAID', 'PROCESSING', 'PENDING', 'FAILED', 'REVERSED', 'CANCELLED'] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

export const BUCKET_LABEL: Record<StatusBucket, string> = {
  PAID: 'Paid',
  PROCESSING: 'In bank file (awaiting bank result)',
  PENDING: 'Pending (not yet in a bank file)',
  FAILED: 'Failed — will be re-banked in the next bank file',
  REVERSED: 'Reversed',
  CANCELLED: 'Cancelled',
};

export interface Money { count: number; paise: number }
const zero = (): Money => ({ count: 0, paise: 0 });

export interface Breakdown {
  buckets: Record<StatusBucket, Money>;
  /** Rows with a status this screen does not know (should be none) — reported, never dropped. */
  other: Money;
  total: Money;
  /** Within PAID: TDS withheld at the bank file, and rows settled wholly by TDS (no bank payment). */
  paidTdsWithheldPaise: number;
  paidSettledByTds: Money;
  /** Within PENDING: rows held out of bank files by a pending reversal request. */
  pendingHeldByReversal: Money;
}

export interface StatusEntryRow extends CreditEntryRow {
  tdsDeductedPaise: bigint;
  heldByReversal: boolean;
}

function emptyBreakdown(): Breakdown {
  return {
    buckets: { PAID: zero(), PROCESSING: zero(), PENDING: zero(), FAILED: zero(), REVERSED: zero(), CANCELLED: zero() },
    other: zero(),
    total: zero(),
    paidTdsWithheldPaise: 0,
    paidSettledByTds: zero(),
    pendingHeldByReversal: zero(),
  };
}

function add(m: Money, paise: number): void {
  m.count += 1;
  m.paise += paise;
}

function addRow(b: Breakdown, e: StatusEntryRow): void {
  const paise = Number(e.amountPaise);
  const st = e.status as StatusBucket;
  if ((STATUS_BUCKETS as readonly string[]).includes(st)) add(b.buckets[st], paise);
  else add(b.other, paise);
  add(b.total, paise);
  if (st === 'PAID') {
    b.paidTdsWithheldPaise += Number(e.tdsDeductedPaise ?? 0n);
    if (e.utr && e.utr.startsWith('TDS-WITHHELD-')) add(b.paidSettledByTds, paise);
  }
  if (st === 'PENDING' && e.heldByReversal) add(b.pendingHeldByReversal, paise);
}

export interface FundView {
  /** Fund Reconciliation's classification of these same rows (face values). */
  committed: Money;
  paid: Money;
  returned: Money;
  /** Vendor-imported history is outside Fund Reconciliation (paid by the previous vendor). */
  excludedVendorImport: Money;
}

export interface PayoutStatusSummary {
  batch: { id: string; batchCode: string; period: string; status: string; totalPayoutPaise: number; sourceKind: string | null };
  overall: Breakdown;
  fields: Array<{ fieldId: string; fieldName: string; breakdown: Breakdown }>;
  /** Σ payout rows created for this upload (== overall.total.paise). */
  entriesTotalPaise: number;
  /** The upload's own total (header). */
  uploadTotalPaise: number;
  reconciles: boolean;
  notes: string[];
  fund: FundView;
  points: { creditedRows: number; creditedPoints: number; notCreditedRows: number; notCreditedPoints: number; deductedRows: number; deductedPoints: number };
}

export interface BatchRowJson {
  outletId?: string;
  fieldId?: string;
  awardType?: string;
  status?: string;
  amount?: number;
}

export function buildPayoutStatus(input: {
  batch: { id: string; batchCode: string; period: string; status: string; totalPayoutPaise: bigint; sourceKind: string | null; rows: unknown };
  entries: StatusEntryRow[];
  visibilityFieldIds: ReadonlySet<string>;
  /** Points rows the confirm did NOT credit (confirm audit `notApplied`). */
  notApplied: Array<{ points?: number; kind?: string }>;
}): PayoutStatusSummary {
  const overall = emptyBreakdown();
  const byField = new Map<string, { fieldName: string; b: Breakdown }>();
  const fund: FundView = { committed: zero(), paid: zero(), returned: zero(), excludedVendorImport: zero() };
  for (const e of input.entries) {
    addRow(overall, e);
    const f = byField.get(e.fieldId) ?? { fieldName: e.fieldName, b: emptyBreakdown() };
    addRow(f.b, e);
    byField.set(e.fieldId, f);
    const paise = Number(e.amountPaise);
    const it = creditItem(e, input.visibilityFieldIds);
    if (!it) add(fund.excludedVendorImport, paise);
    else if (it.status === 'PAID') add(fund.paid, paise);
    else if (it.status === 'RETURNED') add(fund.returned, paise);
    else add(fund.committed, paise);
  }
  const rows = (Array.isArray(input.batch.rows) ? input.batch.rows : []) as BatchRowJson[];
  const okPoints = rows.filter((r) => r && r.status === 'OK' && r.awardType === 'POINTS' && typeof r.amount === 'number');
  const credit = okPoints.filter((r) => (r.amount as number) > 0);
  const deduct = okPoints.filter((r) => (r.amount as number) < 0);
  const notCredited = input.notApplied.filter((n) => n.kind !== 'DEDUCTION');
  const notCreditedPoints = notCredited.reduce((s, n) => s + Math.max(0, Number(n.points ?? 0)), 0);
  const confirmed = input.batch.status !== 'PENDING_CONFIRM';
  const creditedPoints = confirmed ? credit.reduce((s, r) => s + (r.amount as number), 0) - notCreditedPoints : 0;

  const entriesTotalPaise = overall.total.paise;
  const uploadTotalPaise = Number(input.batch.totalPayoutPaise ?? 0n);
  const notes: string[] = [];
  const sumBuckets = STATUS_BUCKETS.reduce((s, k) => s + overall.buckets[k].paise, 0) + overall.other.paise;
  if (overall.other.count > 0) notes.push(`${overall.other.count} payout row(s) have an unknown status — contact Gifsy tech.`);
  if (!confirmed) notes.push('This upload is not confirmed yet — no payouts exist until it is confirmed.');
  else if (entriesTotalPaise !== uploadTotalPaise) {
    notes.push(
      `The upload's own total (₹${(uploadTotalPaise / 100).toFixed(2)}) differs from the payout rows created (₹${(entriesTotalPaise / 100).toFixed(2)}) — rows that were not applied at confirm are not payouts.`,
    );
  }
  if (fund.excludedVendorImport.count > 0) notes.push('Imported vendor history is not part of Fund Reconciliation (paid by the previous vendor).');
  return {
    batch: {
      id: input.batch.id,
      batchCode: input.batch.batchCode,
      period: input.batch.period,
      status: input.batch.status,
      totalPayoutPaise: uploadTotalPaise,
      sourceKind: input.batch.sourceKind,
    },
    overall,
    fields: [...byField.entries()]
      .map(([fieldId, v]) => ({ fieldId, fieldName: v.fieldName, breakdown: v.b }))
      .sort((a, b) => a.fieldName.localeCompare(b.fieldName)),
    entriesTotalPaise,
    uploadTotalPaise,
    reconciles: sumBuckets === entriesTotalPaise && fund.committed.paise + fund.paid.paise + fund.returned.paise + fund.excludedVendorImport.paise === entriesTotalPaise,
    notes,
    fund,
    points: {
      creditedRows: confirmed ? credit.length - notCredited.length : 0,
      creditedPoints,
      notCreditedRows: notCredited.length,
      notCreditedPoints,
      deductedRows: deduct.length,
      deductedPoints: deduct.reduce((s, r) => s + Math.abs(r.amount as number), 0),
    },
  };
}
