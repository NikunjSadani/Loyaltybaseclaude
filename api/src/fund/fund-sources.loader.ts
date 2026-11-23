/**
 * Loads one client's fund inputs from the SOURCE records (no new hooks in the money paths — design §5) and maps them
 * to the pure engine's shapes. Prisma-only (no Nest DI) so the same code runs in the API and the exports worker.
 *
 * Spend rules (FUND-RECONCILIATION-DESIGN.md §3; source fields cited):
 *  VOUCHER — RedemptionOrder, redemptionMode GIFT_CARD (Hubble or manual), tenant = partner.clientId, that was
 *    CONFIRMED (a RedemptionStatusHistory row toStatus=CONFIRMED exists; its createdAt = commit time). Physical gifts
 *    (PHYSICAL_GIFT, incl. a gift fulfilled as a DIGITAL_VOUCHER) are off-portal → excluded.
 *      paid     = status DELIVERED (deliveredAt, else the DELIVERED history row);
 *      returned = status FAILED / CANCELLED / RETURNED (the refund paths: refundAndFailHubble,
 *                 refundAndFailNoHubbleOrder, transitionOrder) — at that history row's createdAt;
 *      else committed (CONFIRMED / PROCESSING / DISPATCHED; Hubble indeterminate metadata.hubbleNeedsReconcile is
 *      committed + flagged).
 *    face = valuePaise (frozen at CONFIRMED). The refund paths ZERO valuePaise, so for a returned order the face is
 *    re-derived exactly as confirm froze it (computeFrozenValuePaise: metadata.sellingValuePaiseSnapshot × quantity,
 *    else totalPointsCost ÷ conversionRateCenti) and flagged FACE_RECOMPUTED.
 *  CASH_REDEMPTION — PayoutTransaction with a redemptionOrderId, payoutMode UPI / BANK_TRANSFER, tenant =
 *    partner.clientId. committed = createdAt (created inside the CONFIRMED claim); paid = SUCCESS (completedAt — incl.
 *    providerResponse.paidOffPlatform); returned = FAILED / REVERSED, or the linked order is FAILED / CANCELLED /
 *    RETURNED while the payout is not SUCCESS (derived from STATUS, never from value: a UTR-FAILED order keeps
 *    valuePaise). face = amountPaise.
 *  CREDIT_PAYOUT / VISIBILITY_PAYOUT — CreditPayoutEntry (clientId direct; PAYOUT award rows only — POINTS credits
 *    never create an entry), stream = CreditField.payoutStream (VISIBILITY → visibility, else credit/target). Imported
 *    vendor history (CreditBatch.sourceKind = VENDOR_IMPORT) is excluded (paid by the previous vendor, not from the
 *    advance). committed = createdAt (created when the batch is CONFIRMED); paid = PAID (paidAt, utr — incl. the
 *    TDS-WITHHELD fully-withheld settlement); returned = REVERSED (before payment). FAILED stays committed (it is
 *    re-banked by a later download) and is flagged. PAID then reversed (PayoutReversalAllocation APPLIED_RECEIVABLE)
 *    stays paid + a receivable (receivablePaise, else amountPaise for a legacy row). face = amountPaise (gross).
 *  TDS_194C — TdsRecoveryEntry section SEC_194C (the 194C TDS Gifsy deposits — gross-up, and no-PAN 194C paid in
 *    full — recovered from this tenant pro-rata). Owner D3 (2026-11-23): dated WITH ITS PAYOUT. A recovery row is
 *    keyed by (PAN or no-PAN outlet, FY) and is a cumulative delta, not per payout, so for each key the NET recovery
 *    (Σ tenantSharePaise — true-ups included) is allocated pro rata by amount over the client's 194C payout entries
 *    of that key and FY that went to the bank (status ≠ PENDING; PAN = the entry's payeePan snapshot, no-PAN = the
 *    outlet), largest remainder in paise. Each piece is a TDS line with its payout's commit date and status (paid /
 *    committed / returned when the payout was reversed before payment). A key with no matching entry keeps its
 *    recovery rows as lines on the day they were recorded, flagged TDS_UNALLOCATED. 194R / DEDUCT TDS excluded.
 */
import { computeFrozenValuePaise } from '../rewards/gift-value.helper';
import type { PrismaService } from '../prisma/prisma.service';
import { fyLabelForPeriod } from '../tds/tds.helpers';
import type { FundFlag, FundManualEntry, FundRateChange, FundRateRow, FundReceivable, FundSpendItem } from './fund-statement.engine';

const PAGE = 2000;
const REFUNDED: ReadonlySet<string> = new Set(['FAILED', 'CANCELLED', 'RETURNED']);

type Db = Pick<
  PrismaService,
  'redemptionOrder' | 'payoutTransaction' | 'creditPayoutEntry' | 'creditField' | 'creditReversal' | 'tdsRecoveryEntry' | 'fundReceipt' | 'fundRate'
>;

/** Keyset pages ordered by id (id is unique + NOT NULL). */
async function allPages<T extends { id: string }>(fetch: (p: { take: number; cursor?: { id: string }; skip?: number }) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const rows = await fetch(cursor ? { take: PAGE, cursor: { id: cursor }, skip: 1 } : { take: PAGE });
    out.push(...rows);
    if (rows.length < PAGE) return out;
    cursor = rows[rows.length - 1].id;
  }
}

function metaObj(m: unknown): Record<string, unknown> | null {
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

const firstAt = (hist: Array<{ toStatus: string; createdAt: Date }>, s: string): Date | null =>
  hist.find((h) => h.toStatus === s)?.createdAt ?? null;
const lastAt = (hist: Array<{ toStatus: string; createdAt: Date }>, s: string): Date | null => {
  for (let i = hist.length - 1; i >= 0; i--) if (hist[i].toStatus === s) return hist[i].createdAt;
  return null;
};

// ── Vouchers ─────────────────────────────────────────────────────────────────────────────────────

export interface VoucherOrderRow {
  id: string;
  orderNumber: string;
  status: string;
  valuePaise: bigint | null;
  quantity: number;
  totalPointsCost: number;
  conversionRateCenti: number | null;
  metadata: unknown;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  updatedAt: Date;
  reward: { id: string; name: string } | null;
  rewardId: string;
  statusHistory: Array<{ toStatus: string; createdAt: Date }>;
}

export function voucherItem(o: VoucherOrderRow): FundSpendItem | null {
  const hist = [...o.statusHistory].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const committedAt = firstAt(hist, 'CONFIRMED');
  if (!committedAt) return null; // never confirmed → never committed (no points left the wallet)
  const flags: FundFlag[] = [];
  const meta = metaObj(o.metadata);
  let face = o.valuePaise ?? 0n;
  if (face <= 0n) {
    const snap = typeof meta?.sellingValuePaiseSnapshot === 'number' ? (meta.sellingValuePaiseSnapshot as number) : null;
    face = computeFrozenValuePaise({
      isCashMode: false,
      sellingValuePaiseSnapshot: snap,
      quantity: o.quantity,
      points: o.totalPointsCost,
      rateCenti: o.conversionRateCenti ?? 0,
    });
    flags.push(face > 0n ? 'FACE_RECOMPUTED' : 'FACE_UNKNOWN');
  }
  const itemLabel = o.reward?.name ?? 'Voucher';
  let status: FundSpendItem['status'] = 'COMMITTED';
  let paidAt: Date | null = null;
  let returnedAt: Date | null = null;
  if (o.status === 'DELIVERED') {
    status = 'PAID';
    // Event timestamps only (never updatedAt — any later edit would move it).
    paidAt = o.deliveredAt ?? lastAt(hist, 'DELIVERED');
    if (!paidAt) flags.push('DATE_ESTIMATED');
  } else if (REFUNDED.has(o.status)) {
    status = 'RETURNED';
    returnedAt = lastAt(hist, o.status) ?? o.cancelledAt;
    if (!returnedAt) flags.push('DATE_ESTIMATED'); // placed on its commit day (nets to zero there)
  } else if (meta?.hubbleNeedsReconcile === true) {
    flags.push('HUBBLE_NEEDS_RECONCILE');
  }
  return {
    key: `order:${o.id}`,
    type: 'VOUCHER',
    ref: o.orderNumber,
    description: `Voucher — ${itemLabel}`,
    source: { kind: 'redemptionOrder', id: o.id },
    facePaise: face,
    // Owner D4: the discount is per voucher ITEM — the order's rewardId is stable, so past orders keep their item.
    rewardId: o.rewardId,
    itemLabel,
    status,
    committedAt,
    paidAt,
    returnedAt,
    flags,
  };
}

// ── Cash redemptions ─────────────────────────────────────────────────────────────────────────────

export interface CashTxnRow {
  id: string;
  amountPaise: bigint;
  status: string;
  payoutMode: string;
  createdAt: Date;
  completedAt: Date | null;
  reversedAt: Date | null;
  updatedAt: Date;
  providerRefId: string | null;
  redemptionOrderId: string | null;
  batch: { batchCode: string } | null;
}

export interface CashOrderInfo {
  orderNumber: string;
  status: string;
  statusHistory: Array<{ toStatus: string; createdAt: Date }>;
}

export function cashItem(t: CashTxnRow, order: CashOrderInfo | undefined): FundSpendItem {
  let status: FundSpendItem['status'] = 'COMMITTED';
  let paidAt: Date | null = null;
  let returnedAt: Date | null = null;
  const flags: FundFlag[] = [];
  const orderRefunded = !!order && REFUNDED.has(order.status);
  if (t.status === 'SUCCESS') {
    status = 'PAID';
    paidAt = t.completedAt; // event timestamp only — never updatedAt
    if (!paidAt) flags.push('DATE_ESTIMATED');
  } else if (t.status === 'FAILED' || t.status === 'REVERSED' || orderRefunded) {
    status = 'RETURNED';
    const hist = order ? [...order.statusHistory].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) : [];
    // The order's refund history row (the UTR-FAILED path flips the order to FAILED in the same tx), else reversedAt.
    const orderRow = orderRefunded ? lastAt(hist, order!.status) : null;
    returnedAt = orderRow ?? t.reversedAt;
    if (!returnedAt) flags.push('DATE_ESTIMATED'); // placed on its commit day (nets to zero there)
  }
  const rail = t.payoutMode === 'UPI' ? 'UPI' : 'bank';
  return {
    key: `ptx:${t.id}`,
    type: 'CASH_REDEMPTION',
    ref: order?.orderNumber ?? t.id,
    description: `Cash redemption (${rail})${t.batch ? ` — batch ${t.batch.batchCode}` : ''}`,
    source: { kind: 'payoutTransaction', id: t.id },
    facePaise: t.amountPaise,
    status,
    committedAt: t.createdAt,
    paidAt,
    returnedAt,
    utr: status === 'PAID' ? t.providerRefId : null,
    flags,
  };
}

// ── Credit / visibility payouts ──────────────────────────────────────────────────────────────────

export interface CreditEntryRow {
  id: string;
  fieldId: string;
  fieldName: string;
  outletId: string;
  outletName: string;
  period: string;
  amountPaise: bigint;
  status: string;
  utr: string | null;
  paidAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  batch: { batchCode: string; sourceKind: string | null };
  reversalAllocations: Array<{ state: string; amountPaise: bigint; receivablePaise: bigint; creditReversal: { approvedAt: Date | null } | null }>;
}

/** What the LEGACY (pre-allocation) payout-reversal path recorded for an entry (from CreditReversal rows). */
export interface LegacyReversalInfo {
  /** Approved-at of the reversal that consumed the entry (CreditReversal.approvedAt). */
  approvedAt: Date | null;
  /** Receivable for a PAID entry the legacy path consumed (net released = amount − TDS withheld). */
  receivablePaise: bigint;
}

export function creditItem(
  e: CreditEntryRow,
  visibilityFieldIds: ReadonlySet<string>,
  legacy?: LegacyReversalInfo,
): FundSpendItem | null {
  if (e.batch.sourceKind === 'VENDOR_IMPORT') return null;
  const isVis = visibilityFieldIds.has(e.fieldId);
  const flags: FundFlag[] = [];
  let status: FundSpendItem['status'] = 'COMMITTED';
  let paidAt: Date | null = null;
  let returnedAt: Date | null = null;
  let receivable = 0n;
  // A paid entry keeps paidAt for ever (a FAILED / PENDING entry never has one). So a REVERSED entry WITH a paidAt was
  // paid before the reversal — incl. a fully TDS-withheld entry that both reversal engines flip PAID → REVERSED: the
  // money (or the deposited TDS) already left, so it stays PAID (never "returned"); recoverable cash is a receivable.
  const wasPaid = e.status === 'PAID' || (e.status === 'REVERSED' && e.paidAt != null);
  if (wasPaid) {
    status = 'PAID';
    paidAt = e.paidAt;
    if (!paidAt) flags.push('DATE_ESTIMATED');
    let fromAllocations = false;
    for (const al of e.reversalAllocations) {
      if (al.state === 'APPLIED_RECEIVABLE') {
        fromAllocations = true;
        receivable += al.receivablePaise > 0n ? al.receivablePaise : al.amountPaise;
      }
    }
    if (!fromAllocations && legacy && legacy.receivablePaise > 0n) receivable += legacy.receivablePaise;
  } else if (e.status === 'REVERSED') {
    status = 'RETURNED';
    const applied = e.reversalAllocations.find((al) => al.state === 'APPLIED_CANCELLED');
    returnedAt = applied?.creditReversal?.approvedAt ?? legacy?.approvedAt ?? null;
    if (!returnedAt) flags.push('DATE_ESTIMATED'); // placed on its commit day (nets to zero there)
  } else if (e.status === 'FAILED') {
    flags.push('FAILED_AWAITING_REBANK');
  }
  return {
    key: `cpe:${e.id}`,
    type: isVis ? 'VISIBILITY_PAYOUT' : 'CREDIT_PAYOUT',
    ref: `${e.batch.batchCode} · ${e.outletId}`,
    description: `${isVis ? 'Visibility payout' : 'Credit payout'} — ${e.fieldName} (${e.period}) to ${e.outletName}`,
    source: { kind: 'creditPayoutEntry', id: e.id },
    facePaise: e.amountPaise,
    status,
    committedAt: e.createdAt,
    paidAt,
    returnedAt,
    utr: status === 'PAID' ? e.utr : null,
    receivablePaise: receivable,
    flags,
  };
}

// ── 194C TDS ─────────────────────────────────────────────────────────────────────────────────────

export interface TdsRecoveryRow {
  id: string;
  panNumber: string;
  fyLabel: string;
  tenantSharePaise: bigint;
  createdAt: Date;
}

/** A 194C payout entry that can carry a share of its PAN / outlet's recovered TDS. */
export interface Tds194cEntry {
  id: string;
  outletId: string;
  period: string;
  amountPaise: bigint;
  status: string;
  payeePan: string | null;
  /** The entry's own spend line (for its commit date + status). */
  item: FundSpendItem;
}

const NO_PAN = '__NO_PAN__';
const maskPan = (p: string) => (p.startsWith(NO_PAN) ? `no PAN (outlet ${p.split(':').slice(1).join(':') || '?'})` : `PAN …${p.slice(-4)}`);

/** Largest-remainder split of `total` (may be negative) by non-negative weights. Σ result === total. */
export function splitPaise(total: bigint, weights: bigint[]): bigint[] {
  const w = weights.reduce((x, y) => x + y, 0n);
  if (w <= 0n) return weights.map(() => 0n);
  const neg = total < 0n;
  const t = neg ? -total : total;
  const base = weights.map((x) => (t * x) / w);
  let left = t - base.reduce((x, y) => x + y, 0n);
  const order = weights
    .map((x, i) => ({ i, rem: (t * x) % w }))
    .sort((p1, p2) => (p2.rem > p1.rem ? 1 : p2.rem < p1.rem ? -1 : p1.i - p2.i));
  for (const o of order) {
    if (left <= 0n) break;
    base[o.i] += 1n;
    left -= 1n;
  }
  return neg ? base.map((x) => -x) : base;
}

/**
 * 194C TDS lines dated with their payouts (owner D3). See the header for the rule. Pure.
 */
export function tdsItems(recoveries: readonly TdsRecoveryRow[], entries: readonly Tds194cEntry[]): FundSpendItem[] {
  const byKey = new Map<string, TdsRecoveryRow[]>();
  for (const r of recoveries) {
    const pan = r.panNumber.trim();
    const k = `${pan.startsWith(NO_PAN) ? pan : pan.toUpperCase()}|${r.fyLabel}`;
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }
  const out: FundSpendItem[] = [];
  for (const [k, rows] of byKey) {
    const [pan, fy] = k.split('|');
    const total = rows.reduce((x, r) => x + r.tenantSharePaise, 0n);
    if (total === 0n) continue;
    const noPanOutlet = pan.startsWith(NO_PAN) ? pan.slice(NO_PAN.length + 1) : null;
    const cands = entries.filter((e) => {
      if (e.status === 'PENDING' || fyLabelForPeriod(e.period) !== fy) return false;
      if (noPanOutlet != null) return e.outletId === noPanOutlet && (!e.payeePan || e.payeePan.startsWith(NO_PAN));
      return (e.payeePan ?? '').trim().toUpperCase() === pan;
    });
    const weights = cands.map((e) => (e.amountPaise > 0n ? e.amountPaise : 0n));
    if (cands.length === 0 || weights.every((x) => x === 0n)) {
      for (const r of rows) {
        if (r.tenantSharePaise === 0n) continue;
        out.push({
          key: `tds:${r.id}`,
          type: 'TDS_194C',
          ref: `TDS 194C · ${r.fyLabel}`,
          description: `${r.tenantSharePaise < 0n ? 'TDS 194C true-up (credit)' : 'TDS 194C borne by Gifsy'} — ${maskPan(pan)} (no matching payout found — shown on the day it was recorded)`,
          source: { kind: 'tdsRecoveryEntry', id: r.id },
          facePaise: r.tenantSharePaise,
          status: 'PAID',
          committedAt: r.createdAt,
          paidAt: r.createdAt,
          flags: ['TDS_UNALLOCATED'],
        });
      }
      continue;
    }
    const parts = splitPaise(total, weights);
    cands.forEach((e, i) => {
      if (parts[i] === 0n) return;
      out.push({
        key: `tds:${k}:${e.id}`,
        type: 'TDS_194C',
        ref: `TDS 194C · ${e.item.ref}`,
        description: `TDS 194C borne by Gifsy on ${e.item.description} — ${maskPan(pan)}, FY ${fy}`,
        source: { kind: 'creditPayoutEntry', id: e.id },
        facePaise: parts[i],
        status: e.item.status,
        committedAt: e.item.committedAt,
        paidAt: e.item.paidAt ?? null,
        returnedAt: e.item.returnedAt ?? null,
        flags: (e.item.flags ?? []).filter((f) => f === 'DATE_ESTIMATED'),
      });
    });
  }
  return out;
}

// ── Loader ───────────────────────────────────────────────────────────────────────────────────────

export interface FundInputs {
  items: FundSpendItem[];
  /** Receivables not tied to one spend line (legacy reversals approved before entries were recorded on them). */
  extraReceivables: FundReceivable[];
  /** Confirmed back-dated rate changes (owner D1) → informational statement lines. */
  rateChanges: FundRateChange[];
  entries: FundManualEntry[];
  rates: FundRateRow[];
  /** Raw rows for the Receipts / Rates sheets + screen. */
  entryRows: Array<{
    id: string;
    entryType: string;
    receiptNumber: string;
    amountPaise: bigint;
    receivedAt: Date;
    paymentMode: string;
    referenceNumber: string | null;
    bankName: string | null;
    notes: string | null;
    reason: string | null;
    createdByUserId: string | null;
    createdAt: Date;
  }>;
  rateRows: Array<{
    id: string;
    kind: string;
    rewardId: string | null;
    rewardLabel: string | null;
    feeType: string | null;
    rateBps: number | null;
    flatPaise: bigint | null;
    effectiveFrom: Date;
    note: string | null;
    repricedLines: number | null;
    repriceDeltaPaise: bigint | null;
    repricedFrom: Date | null;
    createdById: string | null;
    createdAt: Date;
  }>;
}

export async function loadFundInputs(db: Db, clientId: string): Promise<FundInputs> {
  if (!clientId) throw new Error('loadFundInputs: clientId is required');

  const [entryRows, rateRows] = await Promise.all([
    db.fundReceipt.findMany({ where: { clientId }, orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }] }),
    db.fundRate.findMany({ where: { clientId }, orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] }),
  ]);

  const orders = await allPages((p) =>
    db.redemptionOrder.findMany({
      where: {
        partner: { clientId },
        redemptionMode: 'GIFT_CARD',
        statusHistory: { some: { toStatus: 'CONFIRMED' } },
      },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        valuePaise: true,
        quantity: true,
        totalPointsCost: true,
        conversionRateCenti: true,
        metadata: true,
        deliveredAt: true,
        cancelledAt: true,
        updatedAt: true,
        rewardId: true,
        reward: { select: { id: true, name: true } },
        statusHistory: {
          where: { toStatus: { in: ['CONFIRMED', 'DELIVERED', 'FAILED', 'CANCELLED', 'RETURNED'] } },
          select: { toStatus: true, createdAt: true },
        },
      },
      orderBy: { id: 'asc' },
      ...p,
    }),
  );

  const txns = await allPages((p) =>
    db.payoutTransaction.findMany({
      where: { partner: { clientId }, redemptionOrderId: { not: null }, payoutMode: { in: ['UPI', 'BANK_TRANSFER'] } },
      select: {
        id: true,
        amountPaise: true,
        status: true,
        payoutMode: true,
        createdAt: true,
        completedAt: true,
        reversedAt: true,
        updatedAt: true,
        providerRefId: true,
        redemptionOrderId: true,
        batch: { select: { batchCode: true } },
      },
      orderBy: { id: 'asc' },
      ...p,
    }),
  );
  const orderIds = [...new Set(txns.map((t) => t.redemptionOrderId!).filter(Boolean))];
  const cashOrders = new Map<string, CashOrderInfo>();
  for (let i = 0; i < orderIds.length; i += PAGE) {
    const rows = await db.redemptionOrder.findMany({
      where: { id: { in: orderIds.slice(i, i + PAGE) }, partner: { clientId } },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        statusHistory: { where: { toStatus: { in: ['FAILED', 'CANCELLED', 'RETURNED'] } }, select: { toStatus: true, createdAt: true } },
      },
    });
    for (const r of rows) cashOrders.set(r.id, r);
  }

  const visibilityFields = await db.creditField.findMany({ where: { clientId, payoutStream: 'VISIBILITY' }, select: { id: true } });
  const visIds = new Set(visibilityFields.map((f) => f.id));
  const entries = await allPages((p) =>
    db.creditPayoutEntry.findMany({
      where: { clientId },
      select: {
        id: true,
        fieldId: true,
        fieldName: true,
        outletId: true,
        outletName: true,
        period: true,
        amountPaise: true,
        status: true,
        utr: true,
        paidAt: true,
        createdAt: true,
        updatedAt: true,
        batch: { select: { batchCode: true, sourceKind: true } },
        tdsDeductedPaise: true,
        tdsSection: true,
        payeePan: true,
        reversalAllocations: { select: { state: true, amountPaise: true, receivablePaise: true, creditReversal: { select: { approvedAt: true } } } },
      },
      orderBy: { id: 'asc' },
      ...p,
    }),
  );

  // LEGACY payout reversals (approved before the allocation engine — no PayoutReversalAllocation rows): the consumed
  // entries are listed on CreditReversal.consumedPayoutEntryIds; a PAID one became a receivable of its net released
  // amount (credits.service: amount − TDS withheld, summed into shortfallPaise). A legacy reversal approved before
  // consumedPayoutEntryIds existed cannot be tied to entries → a reversal-level receivable of its shortfallPaise.
  const legacyReversals = await db.creditReversal.findMany({
    where: { clientId, awardType: 'PAYOUT', status: { in: ['APPROVED', 'PARTIAL'] }, payoutAllocations: { none: {} } },
    select: { id: true, outletName: true, fieldName: true, period: true, approvedAt: true, shortfallPaise: true, consumedPayoutEntryIds: true },
  });
  const legacyByEntry = new Map<string, { approvedAt: Date | null }>();
  const orphanReceivables: FundReceivable[] = [];
  for (const r of legacyReversals) {
    const ids = Array.isArray(r.consumedPayoutEntryIds)
      ? (r.consumedPayoutEntryIds as unknown[]).filter((x): x is string => typeof x === 'string')
      : null;
    if (ids && ids.length > 0) {
      for (const id of ids) legacyByEntry.set(id, { approvedAt: r.approvedAt });
    } else if (r.shortfallPaise > 0n) {
      orphanReceivables.push({
        ref: `Reversal ${r.id}`,
        description: `Paid credit payout reversed (older reversal — entries not recorded) — ${r.fieldName} (${r.period}) to ${r.outletName}`,
        type: 'CREDIT_PAYOUT',
        source: { kind: 'creditReversal', id: r.id },
        paidAt: null,
        amountPaise: r.shortfallPaise,
      });
    }
  }

  const recoveries = await allPages((p) =>
    db.tdsRecoveryEntry.findMany({
      where: { clientId, section: 'SEC_194C' },
      select: { id: true, panNumber: true, fyLabel: true, tenantSharePaise: true, createdAt: true },
      orderBy: { id: 'asc' },
      ...p,
    }),
  );

  const items: FundSpendItem[] = [];
  for (const o of orders) {
    const it = voucherItem(o as VoucherOrderRow);
    if (it) items.push(it);
  }
  for (const t of txns) items.push(cashItem(t, t.redemptionOrderId ? cashOrders.get(t.redemptionOrderId) : undefined));
  const tds194c: Tds194cEntry[] = [];
  for (const e of entries) {
    const lg = legacyByEntry.get(e.id);
    const withheld = e.tdsDeductedPaise ?? 0n;
    const net = e.amountPaise - (withheld > 0n ? withheld : 0n);
    const legacy: LegacyReversalInfo | undefined = lg
      ? { approvedAt: lg.approvedAt, receivablePaise: e.status === 'PAID' && net > 0n ? net : 0n }
      : undefined;
    const it = creditItem(e as unknown as CreditEntryRow, visIds, legacy);
    if (it) {
      items.push(it);
      if (e.tdsSection === 'SEC_194C') {
        tds194c.push({ id: e.id, outletId: e.outletId, period: e.period, amountPaise: e.amountPaise, status: e.status, payeePan: e.payeePan, item: it });
      }
    }
  }
  items.push(...tdsItems(recoveries, tds194c));

  return {
    items,
    extraReceivables: orphanReceivables,
    rateChanges: rateRows
      .filter((r) => r.repricedLines != null)
      .map((r) => ({
        id: r.id,
        at: r.createdAt,
        effectiveFrom: r.effectiveFrom,
        label: r.kind === 'AGENCY_FEE' ? 'Agency fee change' : `Voucher discount change — ${r.rewardLabel ?? 'item'}`,
        linesRepriced: r.repricedLines ?? 0,
        deltaPaise: r.repriceDeltaPaise ?? 0n,
      })),
    entries: entryRows.map((r) => ({
      id: r.id,
      kind: r.entryType as FundManualEntry['kind'],
      amountPaise: r.amountPaise,
      date: r.receivedAt,
      ref: r.referenceNumber ? `${r.receiptNumber} · ${r.referenceNumber}` : r.receiptNumber,
      note: r.entryType === 'ADJUSTMENT' ? r.reason ?? r.notes : r.notes,
    })),
    rates: rateRows.map((r) => ({
      kind: r.kind as FundRateRow['kind'],
      rewardId: r.rewardId,
      feeType: r.feeType as FundRateRow['feeType'],
      rateBps: r.rateBps,
      flatPaise: r.flatPaise,
      effectiveFrom: r.effectiveFrom,
      createdAt: r.createdAt,
    })),
    entryRows,
    rateRows,
  };
}
