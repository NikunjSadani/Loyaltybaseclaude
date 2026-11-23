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
 *    full — recovered from this tenant pro-rata): tenantSharePaise (a later true-up delta may be negative), at
 *    createdAt (the bank-file run that crystallised it). 194R recovery and DEDUCT-method TDS are excluded.
 */
import { computeFrozenValuePaise } from '../rewards/gift-value.helper';
import type { PrismaService } from '../prisma/prisma.service';
import { voucherBrandOf } from './fund-brand';
import type { FundFlag, FundManualEntry, FundRateRow, FundSpendItem } from './fund-statement.engine';

const PAGE = 2000;
const REFUNDED: ReadonlySet<string> = new Set(['FAILED', 'CANCELLED', 'RETURNED']);

type Db = Pick<
  PrismaService,
  'redemptionOrder' | 'payoutTransaction' | 'creditPayoutEntry' | 'creditField' | 'tdsRecoveryEntry' | 'fundReceipt' | 'fundRate'
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
  reward: { id: string; name: string; metadata: unknown } | null;
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
  const brand = voucherBrandOf(o.reward ?? { id: o.rewardId, name: 'Voucher', metadata: null });
  let status: FundSpendItem['status'] = 'COMMITTED';
  let paidAt: Date | null = null;
  let returnedAt: Date | null = null;
  if (o.status === 'DELIVERED') {
    status = 'PAID';
    paidAt = o.deliveredAt ?? lastAt(hist, 'DELIVERED') ?? o.updatedAt;
  } else if (REFUNDED.has(o.status)) {
    status = 'RETURNED';
    returnedAt = lastAt(hist, o.status) ?? o.cancelledAt ?? o.updatedAt;
  } else if (meta?.hubbleNeedsReconcile === true) {
    flags.push('HUBBLE_NEEDS_RECONCILE');
  }
  return {
    key: `order:${o.id}`,
    type: 'VOUCHER',
    ref: o.orderNumber,
    description: `Voucher — ${o.reward?.name ?? brand.brandLabel}`,
    source: { kind: 'redemptionOrder', id: o.id },
    facePaise: face,
    brandKey: brand.brandKey,
    brandLabel: brand.brandLabel,
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
  const orderRefunded = !!order && REFUNDED.has(order.status);
  if (t.status === 'SUCCESS') {
    status = 'PAID';
    paidAt = t.completedAt ?? t.updatedAt;
  } else if (t.status === 'FAILED' || t.status === 'REVERSED' || orderRefunded) {
    status = 'RETURNED';
    const hist = order ? [...order.statusHistory].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) : [];
    returnedAt = t.reversedAt ?? (order && orderRefunded ? lastAt(hist, order.status) : null) ?? t.updatedAt;
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
  reversalAllocations: Array<{ state: string; amountPaise: bigint; receivablePaise: bigint; updatedAt: Date }>;
}

export function creditItem(e: CreditEntryRow, visibilityFieldIds: ReadonlySet<string>): FundSpendItem | null {
  if (e.batch.sourceKind === 'VENDOR_IMPORT') return null;
  const isVis = visibilityFieldIds.has(e.fieldId);
  const flags: FundFlag[] = [];
  let status: FundSpendItem['status'] = 'COMMITTED';
  let paidAt: Date | null = null;
  let returnedAt: Date | null = null;
  let receivable = 0n;
  if (e.status === 'PAID') {
    status = 'PAID';
    paidAt = e.paidAt ?? e.updatedAt;
    for (const a of e.reversalAllocations) {
      if (a.state === 'APPLIED_RECEIVABLE') receivable += a.receivablePaise > 0n ? a.receivablePaise : a.amountPaise;
    }
  } else if (e.status === 'REVERSED') {
    status = 'RETURNED';
    const applied = e.reversalAllocations.find((a) => a.state === 'APPLIED_CANCELLED');
    returnedAt = applied?.updatedAt ?? e.updatedAt;
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

const maskPan = (p: string) => (p.startsWith('__NO_PAN__') ? `no PAN (outlet ${p.split(':').slice(1).join(':') || '?'})` : `PAN …${p.slice(-4)}`);

export function tdsItem(r: TdsRecoveryRow): FundSpendItem {
  return {
    key: `tds:${r.id}`,
    type: 'TDS_194C',
    ref: `TDS 194C · ${r.fyLabel}`,
    description: `${r.tenantSharePaise < 0n ? 'TDS 194C true-up (credit)' : 'TDS 194C borne by Gifsy'} — ${maskPan(r.panNumber)}`,
    source: { kind: 'tdsRecoveryEntry', id: r.id },
    facePaise: r.tenantSharePaise,
    // Crystallised when the bank file is made; there is no separate "paid" step for the tenant's share.
    status: 'PAID',
    committedAt: r.createdAt,
    paidAt: r.createdAt,
  };
}

// ── Loader ───────────────────────────────────────────────────────────────────────────────────────

export interface FundInputs {
  items: FundSpendItem[];
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
    brandKey: string | null;
    brandLabel: string | null;
    feeType: string | null;
    rateBps: number | null;
    flatPaise: bigint | null;
    effectiveFrom: Date;
    note: string | null;
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
        reward: { select: { id: true, name: true, metadata: true } },
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
        reversalAllocations: { select: { state: true, amountPaise: true, receivablePaise: true, updatedAt: true } },
      },
      orderBy: { id: 'asc' },
      ...p,
    }),
  );

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
  for (const e of entries) {
    const it = creditItem(e as CreditEntryRow, visIds);
    if (it) items.push(it);
  }
  for (const r of recoveries) if (r.tenantSharePaise !== 0n) items.push(tdsItem(r));

  return {
    items,
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
      brandKey: r.brandKey,
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
