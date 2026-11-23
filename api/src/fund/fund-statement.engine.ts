/**
 * Fund statement engine — PURE (no DB, no clock). FUND-RECONCILIATION-DESIGN.md §3/§5.
 *
 * Input: the client's spend items (already loaded from their source records by fund-sources.loader.ts), the money-in
 * entries Gifsy recorded (receipts / adjustments / opening balance) and the effective-dated rate history.
 * Output: a dated event list with a running balance, totals, a breakdown by spend type, receivables and flags.
 *
 * Accounting model (bank-statement style):
 *  - every spend item is ONE debit at its commit date of `charged` (vouchers: face − brand discount; cash /
 *    credit / visibility payouts: face + agency fee; 194C TDS: the TDS Gifsy bears, which may be a negative
 *    true-up);
 *  - a RETURNED item adds ONE credit of the same `charged` at its return date (net effect 0);
 *  - receipts / adjustments are credits (an adjustment may be negative); the opening balance is the first line.
 *  Balance = opening + receipts + adjustments − Σ charged of items not returned (= committed + paid).
 *  Rates: the row in force on the item's COMMIT date (latest effectiveFrom ≤ commit; ties → latest createdAt).
 *  Opening cut-off: an item committed before the opening as-of date is ignored entirely (it is inside the opening
 *  figure); if it is RETURNED on/after that date it is listed in `preOpeningReturns` (never silently dropped — Gifsy
 *  records an adjustment if the money really came back).
 */

export type FundSpendType = 'VOUCHER' | 'CASH_REDEMPTION' | 'CREDIT_PAYOUT' | 'VISIBILITY_PAYOUT' | 'TDS_194C';
export type FundItemStatus = 'COMMITTED' | 'PAID' | 'RETURNED';
export type FundEntryKind = 'RECEIPT' | 'ADJUSTMENT' | 'OPENING_BALANCE';
export type FundEventKind = 'OPENING' | 'RECEIPT' | 'ADJUSTMENT' | 'CHARGE' | 'RETURN';

export const FUND_SPEND_TYPES: readonly FundSpendType[] = [
  'VOUCHER',
  'CASH_REDEMPTION',
  'CREDIT_PAYOUT',
  'VISIBILITY_PAYOUT',
  'TDS_194C',
];

export const FUND_SPEND_TYPE_LABEL: Record<FundSpendType, string> = {
  VOUCHER: 'Vouchers',
  CASH_REDEMPTION: 'Cash redemptions',
  CREDIT_PAYOUT: 'Target / credit payouts',
  VISIBILITY_PAYOUT: 'Visibility payouts',
  TDS_194C: 'TDS 194C (gross-up)',
};

/** Item flags — every one is shown on the statement (owner rule: no silent pass-through). */
export type FundFlag =
  | 'NO_BRAND_RATE' // voucher brand with no discount set → charged at face value
  | 'NO_FEE_RATE' // payout with no agency fee set → no fee charged
  | 'HUBBLE_NEEDS_RECONCILE' // Hubble outcome unknown — counted as committed
  | 'FAILED_AWAITING_REBANK' // credit payout failed at the bank, not reversed — still committed (re-banked later)
  | 'FACE_RECOMPUTED' // the order's frozen value was zeroed by the refund; face re-derived from the order snapshot
  | 'FACE_UNKNOWN'; // no face value could be derived (₹0 charged) — check the source record

export interface FundSpendItem {
  /** Unique across the statement, e.g. `order:<id>`, `ptx:<id>`, `cpe:<id>`, `tds:<id>`. */
  key: string;
  type: FundSpendType;
  /** What the user can search / click: order number, batch code + outlet, … */
  ref: string;
  description: string;
  /** Source record for "open the source" links. */
  source: { kind: 'redemptionOrder' | 'payoutTransaction' | 'creditPayoutEntry' | 'tdsRecoveryEntry'; id: string };
  /** The value the outlet receives (paise). For TDS: the TDS amount (may be negative — a true-up). */
  facePaise: bigint;
  /** VOUCHER only. */
  brandKey?: string | null;
  brandLabel?: string | null;
  status: FundItemStatus;
  committedAt: Date;
  paidAt?: Date | null;
  returnedAt?: Date | null;
  utr?: string | null;
  /** Paid, then reversed: the amount to recover off-platform (shown as "to recover", NOT a credit). */
  receivablePaise?: bigint;
  flags?: FundFlag[];
}

export interface FundManualEntry {
  id: string;
  kind: FundEntryKind;
  /** Signed paise (an ADJUSTMENT may be negative). */
  amountPaise: bigint;
  /** Effective date (start of the IST day). */
  date: Date;
  ref: string;
  note: string | null;
}

export interface FundRateRow {
  kind: 'AGENCY_FEE' | 'VOUCHER_DISCOUNT';
  brandKey?: string | null;
  feeType?: 'PERCENT' | 'FLAT' | null;
  rateBps?: number | null;
  flatPaise?: bigint | null;
  effectiveFrom: Date;
  createdAt: Date;
}

export interface FundLine {
  /** Stable order in the statement (1-based). */
  seq: number;
  date: Date;
  event: FundEventKind;
  type: FundSpendType | null;
  ref: string;
  description: string;
  source: FundSpendItem['source'] | { kind: 'fundReceipt'; id: string };
  facePaise: bigint;
  discountPaise: bigint;
  feePaise: bigint;
  /** TDS lines: the TDS amount (= facePaise); 0 elsewhere. */
  tdsPaise: bigint;
  /** The item's charge (vouchers face − discount; payouts face + fee; TDS the TDS); manual entries 0. */
  chargedPaise: bigint;
  /** Signed effect on the balance (charge = −charged; return = +charged; money-in = +amount). */
  amountPaise: bigint;
  balancePaise: bigint;
  /** Spend lines: the ITEM's current status (a returned item's CHARGE line also shows RETURNED). */
  status: FundItemStatus | null;
  committedAt: Date | null;
  paidAt: Date | null;
  returnedAt: Date | null;
  utr: string | null;
  brandLabel: string | null;
  /** Rate applied (bps for % / flat paise) — for the statement's "rate" column. */
  rateLabel: string | null;
  receivablePaise: bigint;
  flags: FundFlag[];
}

export interface FundTypeTotals {
  type: FundSpendType;
  count: number;
  facePaise: bigint;
  discountPaise: bigint;
  feePaise: bigint;
  /** Σ charged of items still COMMITTED. */
  committedPaise: bigint;
  /** Σ charged of PAID items. */
  paidPaise: bigint;
  /** Σ charged of RETURNED items (already credited back — informational). */
  returnedPaise: bigint;
  /** committed + paid (what this type has taken off the advance). */
  netChargedPaise: bigint;
}

export interface FundTotals {
  openingPaise: bigint;
  receiptsPaise: bigint;
  adjustmentsPaise: bigint;
  committedPaise: bigint;
  paidPaise: bigint;
  returnedPaise: bigint;
  /** opening + receipts + adjustments − committed − paid. */
  balancePaise: bigint;
  faceTotalPaise: bigint;
  discountTotalPaise: bigint;
  feeTotalPaise: bigint;
  tdsTotalPaise: bigint;
}

export interface FundStatement {
  lines: FundLine[];
  totals: FundTotals;
  byType: FundTypeTotals[];
  receivables: { items: Array<Pick<FundLine, 'ref' | 'description' | 'type' | 'source' | 'paidAt'> & { amountPaise: bigint }>; totalPaise: bigint };
  /** Items committed BEFORE the opening date and returned on/after it — not credited automatically. */
  preOpeningReturns: { items: Array<{ ref: string; type: FundSpendType; returnedAt: Date; facePaise: bigint; source: FundSpendItem['source'] }>; facePaise: bigint };
  /** Money-in entries dated before the opening date (already inside the opening figure) — excluded and listed. */
  excludedEntries: FundManualEntry[];
  flagCounts: Partial<Record<FundFlag, number>>;
  /** Voucher brands seen without a discount rate (label → count). */
  brandsWithoutRate: Array<{ brandKey: string; brandLabel: string; count: number }>;
  openingDate: Date | null;
}

// ── Rates ────────────────────────────────────────────────────────────────────────────────────────

/** The rate row in force at `at`: latest effectiveFrom ≤ at; ties → latest createdAt. */
export function rateInForce<T extends FundRateRow>(rows: readonly T[], at: Date): T | null {
  let best: T | null = null;
  const t = at.getTime();
  for (const r of rows) {
    const ef = r.effectiveFrom.getTime();
    if (ef > t) continue;
    if (
      !best ||
      ef > best.effectiveFrom.getTime() ||
      (ef === best.effectiveFrom.getTime() && r.createdAt.getTime() > best.createdAt.getTime())
    ) {
      best = r;
    }
  }
  return best;
}

/** round-half-up of amount × bps / 10000 for a non-negative amount (paise). Negative amounts mirror. */
export function applyBps(amountPaise: bigint, bps: number): bigint {
  if (!bps) return 0n;
  const b = BigInt(Math.round(bps));
  const neg = amountPaise < 0n;
  const a = neg ? -amountPaise : amountPaise;
  const v = (a * b + 5000n) / 10000n;
  return neg ? -v : v;
}

export function bpsLabel(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

const rupeeLabel = (p: bigint) => `₹${(Number(p) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface FundCharge {
  discountPaise: bigint;
  feePaise: bigint;
  tdsPaise: bigint;
  chargedPaise: bigint;
  rateLabel: string | null;
  flags: FundFlag[];
}

/** What one item is charged, at the rates in force on its commit date. */
export function chargeFor(item: FundSpendItem, rates: readonly FundRateRow[]): FundCharge {
  const flags: FundFlag[] = [];
  if (item.type === 'TDS_194C') {
    return { discountPaise: 0n, feePaise: 0n, tdsPaise: item.facePaise, chargedPaise: item.facePaise, rateLabel: null, flags };
  }
  if (item.type === 'VOUCHER') {
    const key = item.brandKey ?? '';
    const brandRows = rates.filter((r) => r.kind === 'VOUCHER_DISCOUNT' && (r.brandKey ?? '') === key && key !== '');
    const r = rateInForce(brandRows, item.committedAt);
    if (!r || r.rateBps == null) {
      flags.push('NO_BRAND_RATE');
      return { discountPaise: 0n, feePaise: 0n, tdsPaise: 0n, chargedPaise: item.facePaise, rateLabel: null, flags };
    }
    const discount = applyBps(item.facePaise, r.rateBps);
    return { discountPaise: discount, feePaise: 0n, tdsPaise: 0n, chargedPaise: item.facePaise - discount, rateLabel: bpsLabel(r.rateBps), flags };
  }
  // Cash redemption / credit payout / visibility payout → agency fee.
  const feeRows = rates.filter((r) => r.kind === 'AGENCY_FEE');
  const r = rateInForce(feeRows, item.committedAt);
  if (!r || !r.feeType) {
    flags.push('NO_FEE_RATE');
    return { discountPaise: 0n, feePaise: 0n, tdsPaise: 0n, chargedPaise: item.facePaise, rateLabel: null, flags };
  }
  let fee = 0n;
  let label: string;
  if (r.feeType === 'FLAT') {
    fee = r.flatPaise ?? 0n;
    label = `${rupeeLabel(fee)} flat`;
  } else {
    fee = applyBps(item.facePaise, r.rateBps ?? 0);
    label = bpsLabel(r.rateBps ?? 0);
  }
  return { discountPaise: 0n, feePaise: fee, tdsPaise: 0n, chargedPaise: item.facePaise + fee, rateLabel: label, flags };
}

// ── Statement ────────────────────────────────────────────────────────────────────────────────────

const EVENT_ORDER: Record<FundEventKind, number> = { OPENING: 0, RECEIPT: 1, ADJUSTMENT: 2, CHARGE: 3, RETURN: 4 };

interface PendingLine extends Omit<FundLine, 'seq' | 'balancePaise'> {
  sortKey: string;
}

export interface BuildStatementInput {
  items: readonly FundSpendItem[];
  entries: readonly FundManualEntry[];
  rates: readonly FundRateRow[];
}

export function buildFundStatement(input: BuildStatementInput): FundStatement {
  const opening = input.entries.find((e) => e.kind === 'OPENING_BALANCE') ?? null;
  const openingDate = opening ? opening.date : null;
  const cutoff = openingDate ? openingDate.getTime() : -Infinity;

  const pending: PendingLine[] = [];
  const excludedEntries: FundManualEntry[] = [];
  const totals: FundTotals = {
    openingPaise: 0n,
    receiptsPaise: 0n,
    adjustmentsPaise: 0n,
    committedPaise: 0n,
    paidPaise: 0n,
    returnedPaise: 0n,
    balancePaise: 0n,
    faceTotalPaise: 0n,
    discountTotalPaise: 0n,
    feeTotalPaise: 0n,
    tdsTotalPaise: 0n,
  };

  for (const e of input.entries) {
    if (e.kind !== 'OPENING_BALANCE' && e.date.getTime() < cutoff) {
      excludedEntries.push(e);
      continue;
    }
    const event: FundEventKind = e.kind === 'OPENING_BALANCE' ? 'OPENING' : e.kind === 'RECEIPT' ? 'RECEIPT' : 'ADJUSTMENT';
    if (e.kind === 'OPENING_BALANCE') totals.openingPaise += e.amountPaise;
    else if (e.kind === 'RECEIPT') totals.receiptsPaise += e.amountPaise;
    else totals.adjustmentsPaise += e.amountPaise;
    pending.push({
      sortKey: `${e.id}`,
      date: e.date,
      event,
      type: null,
      ref: e.ref,
      description:
        e.kind === 'OPENING_BALANCE' ? 'Opening balance' : e.kind === 'RECEIPT' ? 'Advance received' : 'Adjustment',
      source: { kind: 'fundReceipt', id: e.id },
      facePaise: 0n,
      discountPaise: 0n,
      feePaise: 0n,
      tdsPaise: 0n,
      chargedPaise: 0n,
      amountPaise: e.amountPaise,
      status: null,
      committedAt: null,
      paidAt: null,
      returnedAt: null,
      utr: null,
      brandLabel: null,
      rateLabel: null,
      receivablePaise: 0n,
      flags: [],
    });
    if (e.note) pending[pending.length - 1].description += ` — ${e.note}`;
  }

  const byType = new Map<FundSpendType, FundTypeTotals>(
    FUND_SPEND_TYPES.map((t) => [
      t,
      { type: t, count: 0, facePaise: 0n, discountPaise: 0n, feePaise: 0n, committedPaise: 0n, paidPaise: 0n, returnedPaise: 0n, netChargedPaise: 0n },
    ]),
  );
  const receivables: FundStatement['receivables'] = { items: [], totalPaise: 0n };
  const preOpeningReturns: FundStatement['preOpeningReturns'] = { items: [], facePaise: 0n };
  const flagCounts: Partial<Record<FundFlag, number>> = {};
  const noRateBrands = new Map<string, { brandKey: string; brandLabel: string; count: number }>();

  for (const item of input.items) {
    if (item.committedAt.getTime() < cutoff) {
      if (item.status === 'RETURNED' && item.returnedAt && item.returnedAt.getTime() >= cutoff) {
        preOpeningReturns.items.push({ ref: item.ref, type: item.type, returnedAt: item.returnedAt, facePaise: item.facePaise, source: item.source });
        preOpeningReturns.facePaise += item.facePaise;
      }
      continue;
    }
    const c = chargeFor(item, input.rates);
    const flags = [...(item.flags ?? []), ...c.flags];
    for (const f of flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
    if (flags.includes('NO_BRAND_RATE')) {
      const k = item.brandKey ?? '(no brand)';
      const cur = noRateBrands.get(k) ?? { brandKey: k, brandLabel: item.brandLabel ?? k, count: 0 };
      cur.count += 1;
      noRateBrands.set(k, cur);
    }

    const t = byType.get(item.type)!;
    t.count += 1;
    t.facePaise += item.facePaise;
    t.discountPaise += c.discountPaise;
    t.feePaise += c.feePaise;
    if (item.status === 'COMMITTED') {
      t.committedPaise += c.chargedPaise;
      totals.committedPaise += c.chargedPaise;
    } else if (item.status === 'PAID') {
      t.paidPaise += c.chargedPaise;
      totals.paidPaise += c.chargedPaise;
    } else {
      t.returnedPaise += c.chargedPaise;
      totals.returnedPaise += c.chargedPaise;
    }
    if (item.status !== 'RETURNED') {
      t.netChargedPaise += c.chargedPaise;
      totals.faceTotalPaise += item.type === 'TDS_194C' ? 0n : item.facePaise;
      totals.discountTotalPaise += c.discountPaise;
      totals.feeTotalPaise += c.feePaise;
      totals.tdsTotalPaise += c.tdsPaise;
    }

    const base = {
      type: item.type,
      ref: item.ref,
      source: item.source,
      facePaise: item.facePaise,
      discountPaise: c.discountPaise,
      feePaise: c.feePaise,
      tdsPaise: c.tdsPaise,
      chargedPaise: c.chargedPaise,
      status: item.status,
      committedAt: item.committedAt,
      paidAt: item.paidAt ?? null,
      returnedAt: item.returnedAt ?? null,
      utr: item.utr ?? null,
      brandLabel: item.brandLabel ?? null,
      rateLabel: c.rateLabel,
      receivablePaise: item.receivablePaise ?? 0n,
      flags,
    };
    pending.push({ ...base, sortKey: item.key, date: item.committedAt, event: 'CHARGE', description: item.description, amountPaise: -c.chargedPaise });
    if (item.status === 'RETURNED') {
      // A returned item with no return date is returned "at" its commit (net 0 on the same day).
      const at = item.returnedAt ?? item.committedAt;
      pending.push({ ...base, sortKey: item.key, date: at, event: 'RETURN', description: `Returned — ${item.description}`, amountPaise: c.chargedPaise });
    }
    if ((item.receivablePaise ?? 0n) > 0n) {
      receivables.items.push({ ref: item.ref, description: item.description, type: item.type, source: item.source, paidAt: item.paidAt ?? null, amountPaise: item.receivablePaise! });
      receivables.totalPaise += item.receivablePaise!;
    }
  }

  pending.sort((a, b) => {
    const d = a.date.getTime() - b.date.getTime();
    if (d) return d;
    const e = EVENT_ORDER[a.event] - EVENT_ORDER[b.event];
    if (e) return e;
    return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
  });
  // The opening line always leads (it is the balance at the start of its day).
  const oi = pending.findIndex((p) => p.event === 'OPENING');
  if (oi > 0) pending.unshift(...pending.splice(oi, 1));

  let bal = 0n;
  const lines: FundLine[] = pending.map((p, i) => {
    bal += p.amountPaise;
    const { sortKey: _sortKey, ...rest } = p;
    void _sortKey;
    return { ...rest, seq: i + 1, balancePaise: bal };
  });

  totals.balancePaise = totals.openingPaise + totals.receiptsPaise + totals.adjustmentsPaise - totals.committedPaise - totals.paidPaise;

  return {
    lines,
    totals,
    byType: [...byType.values()],
    receivables,
    preOpeningReturns,
    excludedEntries,
    flagCounts,
    brandsWithoutRate: [...noRateBrands.values()].sort((a, b) => b.count - a.count),
    openingDate,
  };
}

// ── Period view ──────────────────────────────────────────────────────────────────────────────────

export interface FundPeriodSummary {
  from: Date | null;
  to: Date | null;
  /** Balance just before `from` (the statement's running balance). */
  openingBalancePaise: bigint;
  /** Balance at the end of the period. */
  closingBalancePaise: bigint;
  /** The client's opening-balance entry, when it is dated inside the period. */
  openingEntryPaise: bigint;
  receiptsPaise: bigint;
  adjustmentsPaise: bigint;
  /** Σ charges dated in the period (all items, whatever their status now). */
  chargesPaise: bigint;
  /** Σ returns dated in the period. */
  returnsPaise: bigint;
  byType: Array<{ type: FundSpendType; count: number; facePaise: bigint; discountPaise: bigint; feePaise: bigint; chargesPaise: bigint; returnsPaise: bigint }>;
}

/** Figures for the lines dated in [from, to) (either bound optional). Uses the full statement's running balance. */
export function periodSummary(stmt: FundStatement, from: Date | null, to: Date | null): FundPeriodSummary {
  let closing: bigint | null = null;
  const s: FundPeriodSummary = {
    from,
    to,
    openingBalancePaise: 0n,
    closingBalancePaise: 0n,
    openingEntryPaise: 0n,
    receiptsPaise: 0n,
    adjustmentsPaise: 0n,
    chargesPaise: 0n,
    returnsPaise: 0n,
    byType: [],
  };
  const bt = new Map(FUND_SPEND_TYPES.map((t) => [t, { type: t, count: 0, facePaise: 0n, discountPaise: 0n, feePaise: 0n, chargesPaise: 0n, returnsPaise: 0n }]));
  let lastBefore = 0n;
  for (const l of stmt.lines) {
    if (from && l.date.getTime() < from.getTime()) {
      lastBefore = l.balancePaise;
      continue;
    }
    if (to && l.date.getTime() >= to.getTime()) break; // lines are date-ordered
    closing = l.balancePaise;
    // An OPENING entry dated inside the period is its own figure (neither a receipt nor an adjustment), so
    // closing = opening balance + opening entry + receipts + adjustments − charges + returns always reconciles.
    if (l.event === 'OPENING') s.openingEntryPaise += l.amountPaise;
    else if (l.event === 'RECEIPT') s.receiptsPaise += l.amountPaise;
    else if (l.event === 'ADJUSTMENT') s.adjustmentsPaise += l.amountPaise;
    else if (l.event === 'CHARGE' && l.type) {
      s.chargesPaise += l.chargedPaise;
      const t = bt.get(l.type)!;
      t.count += 1;
      t.facePaise += l.facePaise;
      t.discountPaise += l.discountPaise;
      t.feePaise += l.feePaise;
      t.chargesPaise += l.chargedPaise;
    } else if (l.event === 'RETURN' && l.type) {
      s.returnsPaise += l.chargedPaise;
      bt.get(l.type)!.returnsPaise += l.chargedPaise;
    }
  }
  s.openingBalancePaise = lastBefore;
  s.closingBalancePaise = closing ?? lastBefore;
  s.byType = [...bt.values()];
  return s;
}
