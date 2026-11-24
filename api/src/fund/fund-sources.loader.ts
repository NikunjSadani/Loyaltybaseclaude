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
 *    stays paid + a receivable (receivablePaise as stored — legacy/backfilled rows carry the amount). face = amountPaise.
 *  TDS_194C — TdsRecoveryEntry section SEC_194C (the 194C TDS Gifsy deposits — gross-up, and no-PAN 194C paid in
 *    full — recovered from this tenant). Owner decision 2026-11-24 (replaces the D3 allocation): charged IN FULL as what
 *    Gifsy actually pays, WITH ITS BANK RUN, one frozen line per recovery row — rules in tdsItems() below. 194R / DEDUCT
 *    TDS excluded.
 */
import { computeFrozenValuePaise } from '../rewards/gift-value.helper';
import type { PrismaService } from '../prisma/prisma.service';
import type { FundFlag, FundManualEntry, FundRateChange, FundRateRow, FundReceivable, FundSpendItem } from './fund-statement.engine';

const PAGE = 2000;
const REFUNDED: ReadonlySet<string> = new Set(['FAILED', 'CANCELLED', 'RETURNED']);

type Db = Pick<
  PrismaService,
  'redemptionOrder' | 'payoutTransaction' | 'creditPayoutEntry' | 'creditField' | 'creditReversal' | 'creditPayoutDownload' | 'tdsRecoveryEntry' | 'fundReceipt' | 'fundRate'
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
        // receivablePaise is NOT NULL (default 0) and backfilled legacy rows carry receivablePaise = amountPaise, so it is
        // used as-is: a genuine ₹0 (e.g. the whole payout was withheld as TDS) must never fall back to the gross.
        receivable += al.receivablePaise;
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
  /** This tenant's base behind the row (no-PAN rows: this run's base). */
  tenantBasePaise: bigint;
  /** The PAN's / outlet's cumulative base for the year at this event. */
  panBasePaise: bigint;
  createdAt: Date;
}

/** A client bank run (CreditPayoutDownload). */
export interface TdsRun {
  id: string;
  downloadCode: string;
  downloadedAt: Date;
}

/** A 194C payout entry with the bank run it was last sent in. */
export interface Tds194cEntry {
  id: string;
  outletId: string;
  amountPaise: bigint;
  payeePan: string | null;
  downloadId: string | null;
  /** The entry's own spend line (status + dates). */
  item: FundSpendItem;
}

const NO_PAN = '__NO_PAN__';
const maskPan = (p: string) => (p.startsWith(NO_PAN) ? `no PAN (outlet ${p.split(':').slice(1).join(':') || '?'})` : `PAN …${p.slice(-4)}`);
/** A recovery row is written in the SAME transaction as its bank run, right after the run row → within this window. */
export const TDS_RUN_MATCH_WINDOW_MS = 10 * 60_000;

/**
 * 194C TDS lines — owner decision 2026-11-24 (replaces the D3 allocation): charged as WHAT GIFSY ACTUALLY PAYS, WITH ITS
 * BANK RUN. One line per TdsRecoveryEntry (frozen: a line depends only on its own row and its own run, so later
 * payouts never change an earlier line):
 *  - amount = the row's tenantSharePaise, in FULL; dated with its bank run (the run's downloadedAt; the row's own
 *    createdAt when the run can't be identified). The opening cut-off applies to that date.
 *  - the run = the client's latest CreditPayoutDownload made ≤ 10 min before the row (written in the same transaction);
 *    its payouts for this TDS = the run's 194C entries of the same PAN (payeePan snapshot) / no-PAN outlet.
 *  - status follows those payouts: all paid → PAID (latest paidAt); all reversed before payment → RETURNED (latest
 *    return date) — the only case a return is shown; anything else → COMMITTED. Run or payouts not identifiable →
 *    PAID on the recorded day, flag TDS_RUN_UNMATCHED (status not tracked). A FAILED payout re-banked in a later run, or
 *    one reversed by the legacy path (which clears downloadId), leaves its original run → that run may become
 *    unmatched or lose the return; lines are never re-split.
 *  - "includes TDS for earlier payouts this year" (flag TDS_INCLUDES_EARLIER + note): the row's base is larger than
 *    this run's payouts (no-PAN rows: panBasePaise > tenantBasePaise; PAN rows: tenantBasePaise > the run's matched
 *    amount) — the yearly limit was crossed / a catch-up.
 *  - a negative row (true-up) → a credit line dated when recorded (PAID), never matched to a run.
 */
export function tdsItems(recoveries: readonly TdsRecoveryRow[], runs: readonly TdsRun[], entries: readonly Tds194cEntry[]): FundSpendItem[] {
  const out: FundSpendItem[] = [];
  const sortedRuns = [...runs].sort((a, b) => a.downloadedAt.getTime() - b.downloadedAt.getTime());
  for (const r of recoveries) {
    if (r.tenantSharePaise === 0n) continue;
    const raw = r.panNumber.trim();
    const pan = raw.startsWith(NO_PAN) ? raw : raw.toUpperCase();
    const noPanOutlet = pan.startsWith(NO_PAN) ? pan.slice(NO_PAN.length + 1) : null;
    const base = {
      type: 'TDS_194C' as const,
      source: { kind: 'tdsRecoveryEntry' as const, id: r.id },
      facePaise: r.tenantSharePaise,
    };
    if (r.tenantSharePaise < 0n) {
      out.push({
        ...base,
        key: `tds:${r.id}`,
        ref: `TDS 194C true-up · FY ${r.fyLabel}`,
        description: `TDS 194C true-up (credit) — ${maskPan(pan)}, FY ${r.fyLabel}`,
        status: 'PAID',
        committedAt: r.createdAt,
        paidAt: r.createdAt,
      });
      continue;
    }
    let run: TdsRun | null = null;
    for (const d of sortedRuns) {
      const gap = r.createdAt.getTime() - d.downloadedAt.getTime();
      if (gap >= 0 && gap <= TDS_RUN_MATCH_WINDOW_MS) run = d; // latest qualifying run wins
    }
    const matched = run
      ? entries.filter(
          (e) =>
            e.downloadId === run!.id &&
            (noPanOutlet != null ? e.outletId === noPanOutlet && (!e.payeePan || e.payeePan.startsWith(NO_PAN)) : (e.payeePan ?? '').trim().toUpperCase() === pan),
        )
      : [];
    const runBase = matched.reduce((x, e) => x + e.amountPaise, 0n);
    const includesEarlier = noPanOutlet != null ? r.panBasePaise > r.tenantBasePaise : matched.length > 0 && r.tenantBasePaise > runBase;
    const flags: FundSpendItem['flags'] = [];
    if (includesEarlier) flags.push('TDS_INCLUDES_EARLIER');
    const note = includesEarlier ? ' — includes TDS for earlier payouts this year (yearly limit crossed)' : '';
    if (!run || matched.length === 0) {
      flags.push('TDS_RUN_UNMATCHED');
      out.push({
        ...base,
        key: `tds:${r.id}`,
        ref: `TDS 194C · FY ${r.fyLabel}`,
        description: `TDS 194C borne by Gifsy — ${maskPan(pan)}, FY ${r.fyLabel} (bank run not identified)${note}`,
        status: 'PAID',
        committedAt: r.createdAt,
        paidAt: r.createdAt,
        flags,
      });
      continue;
    }
    const statuses = matched.map((e) => e.item.status);
    let status: FundSpendItem['status'] = 'COMMITTED';
    let paidAt: Date | null = null;
    let returnedAt: Date | null = null;
    if (statuses.every((s) => s === 'PAID')) {
      status = 'PAID';
      paidAt = matched.reduce<Date | null>((m, e) => (e.item.paidAt && (!m || e.item.paidAt > m) ? e.item.paidAt : m), null);
      if (!paidAt) flags.push('DATE_ESTIMATED');
    } else if (statuses.every((s) => s === 'RETURNED')) {
      status = 'RETURNED';
      returnedAt = matched.reduce<Date | null>((m, e) => (e.item.returnedAt && (!m || e.item.returnedAt > m) ? e.item.returnedAt : m), null);
      if (!returnedAt) flags.push('DATE_ESTIMATED');
    }
    out.push({
      ...base,
      key: `tds:${r.id}`,
      ref: `TDS 194C · ${run.downloadCode}`,
      description: `TDS 194C borne by Gifsy with bank run ${run.downloadCode} (${matched.length} payout${matched.length === 1 ? '' : 's'}) — ${maskPan(pan)}, FY ${r.fyLabel}${note}`,
      status,
      committedAt: run.downloadedAt,
      paidAt,
      returnedAt,
      flags,
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
        downloadId: true,
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
      select: { id: true, panNumber: true, fyLabel: true, tenantSharePaise: true, tenantBasePaise: true, panBasePaise: true, createdAt: true },
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
        tds194c.push({ id: e.id, outletId: e.outletId, amountPaise: e.amountPaise, payeePan: e.payeePan, downloadId: e.downloadId, item: it });
      }
    }
  }
  const runs = recoveries.length
    ? await db.creditPayoutDownload.findMany({ where: { clientId }, select: { id: true, downloadCode: true, downloadedAt: true } })
    : [];
  items.push(...tdsItems(recoveries, runs, tds194c));

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
