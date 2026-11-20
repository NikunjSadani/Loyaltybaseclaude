/**
 * Redemption report — PURE row building (no database, no HTTP). The export kind loads a page of orders + their lookups
 * and hands them here; tests drive these functions directly.
 *
 * DATA HANDLING (owner rule): this module never receives — and the loader never selects — voucherCode, voucherPin,
 * PAN (partner.panNumber / order.payeePan), deliveryName / deliveryPhone / deliveryAddressLine1/2, or bank details.
 * The redeemer's phone is masked to its last 4 digits here ("XXXXXX1234").
 *
 * NO SILENT BLANKS (owner rule): a value the system should have but does not reads "Not recorded" / "Not set"; a value
 * that does not apply to this order reads "—"; a stage the order went past without entering reads "Skipped". Every
 * one of these is explained on the About sheet.
 */
import type { RedemptionStatus } from '@prisma/client';
import { istDateTimeCell } from '../../common/ist-date';
import { rungDisplayLabel } from '../../common/hierarchy-labels';
import type { HyperlinkCell } from '../../common/xlsx';
import type { XlsxCell } from '../../common/xlsx-stream';
import type { RedemptionRewardType } from '../dto/redemption-report.dto';

export const NOT_RECORDED = 'Not recorded';
export const NOT_SET = 'Not set';
export const NOT_APPLICABLE = '—';
export const SKIPPED = 'Skipped';
export const NOT_ASSIGNED = 'Not assigned';
export const SYSTEM = 'System';

export const STATUS_LABEL: Record<RedemptionStatus, string> = {
  PENDING: 'Placed',
  CONFIRMED: 'Confirmed',
  PROCESSING: 'Processing',
  DISPATCHED: 'Dispatched',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURNED: 'Returned',
  FAILED: 'Failed',
};

export const REWARD_TYPE_LABEL: Record<RedemptionRewardType, string> = {
  E_VOUCHER: 'E-voucher',
  PHYSICAL_GIFT: 'Physical gift',
  CASH: 'Cash / UPI',
};

const PAYOUT_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  INITIATED: 'Sent to bank',
  PROCESSING: 'Processing',
  SUCCESS: 'Paid',
  FAILED: 'Failed',
  REVERSED: 'Reversed',
  HOLD: 'On hold',
};

const PARTNER_ROLE_LABEL: Record<string, string> = { SSS: 'SSS', WHOLESALER: 'Wholesaler', SUB_STOCKIST: 'Sub-Stockist' };

/** The happy path, in order. Rank = index. */
export const HAPPY_STAGES: readonly RedemptionStatus[] = ['PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'DELIVERED'];
export const END_STAGES: readonly RedemptionStatus[] = ['CANCELLED', 'RETURNED', 'FAILED'];
/** Orders that actually took points and are going / went through (the Summary's "live" columns). */
export const LIVE_STATUSES: readonly RedemptionStatus[] = ['CONFIRMED', 'PROCESSING', 'DISPATCHED', 'DELIVERED'];

// ─── Input shapes (exactly what the loader selects) ────────────────────────────────────────────────────────────

export interface ReportOrder {
  id: string;
  orderNumber: string;
  status: RedemptionStatus;
  quantity: number;
  totalPointsCost: number;
  valuePaise: bigint | null;
  redemptionMode: string;
  fulfilmentChannel: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryPincode: string | null;
  trackingNumber: string | null;
  logisticsPartner: string | null;
  voucherProvider: string | null;
  podUrl: string | null;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  metadata: unknown;
  createdAt: Date;
  reward: {
    name: string;
    metadata: unknown;
    category: { name: string } | null;
  } | null;
  fulfilledByVendor: { name: string } | null;
  partner: {
    id: string;
    userId: string | null;
    ownerName: string | null;
    businessName: string | null;
    phone: string | null;
    user: { name: string | null; role: string } | null;
    outlets: ReportOutlet[];
  } | null;
}

export interface ReportOutlet {
  id: string;
  outletCode: string;
  name: string;
  city: string | null;
  state: string | null;
  zone: string | null;
  programName: string | null;
  programCategory: string | null;
  outletTypeId: string;
  outletType: { name: string; code: string } | null;
}

export interface HistoryRow {
  id: string;
  orderId: string;
  fromStatus: RedemptionStatus | null;
  toStatus: RedemptionStatus;
  changedById: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface PayoutRow {
  redemptionOrderId: string | null;
  status: string;
  completedAt: Date | null;
  providerRefId: string | null;
  tdsPaise: bigint;
}

export interface LevelDef {
  id: string;
  code: string;
  name: string | null;
  level: number;
}

export interface SalesNode {
  id: string;
  reportingToId: string | null;
  employeeCode: string;
  hierarchyLevelId: string;
  isActive: boolean;
  deletedAt: Date | null;
  user: { name: string | null; status: string } | null;
}

// ─── Small helpers ─────────────────────────────────────────────────────────────────────────────────────────────

const text = (v: string | null | undefined, missing = NOT_RECORDED): string => {
  const t = (v ?? '').trim();
  return t ? t : missing;
};

const inr = (paise: bigint) => Number(paise) / 100;
const days = (ms: number) => Math.round((ms / 86_400_000) * 10) / 10;

/** Last 4 digits only, e.g. "XXXXXX1234". Fewer than 4 digits → "Not recorded" (never the raw value). */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 4) return NOT_RECORDED;
  return `XXXXXX${digits.slice(-4)}`;
}

export function rewardTypeOf(o: Pick<ReportOrder, 'redemptionMode' | 'fulfilmentChannel'>): RedemptionRewardType {
  if (o.redemptionMode === 'UPI' || o.redemptionMode === 'BANK_TRANSFER') return 'CASH';
  if (o.redemptionMode === 'GIFT_CARD' || o.fulfilmentChannel === 'DIGITAL_VOUCHER') return 'E_VOUCHER';
  return 'PHYSICAL_GIFT';
}

/** The catalogue has no brand column; a brand is read only from the reward's metadata (brand / brandName). */
export function brandOf(rewardMetadata: unknown): string {
  if (rewardMetadata && typeof rewardMetadata === 'object' && !Array.isArray(rewardMetadata)) {
    const m = rewardMetadata as Record<string, unknown>;
    for (const k of ['brand', 'brandName']) {
      const v = m[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return NOT_RECORDED;
}

/** The outlet a redemption belongs to: the partner's primary outlet, else its oldest (the loader orders them so). */
export function outletOf(o: ReportOrder): ReportOutlet | null {
  return o.partner?.outlets[0] ?? null;
}

function metadataString(meta: unknown, key: string): string | null {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const v = (meta as Record<string, unknown>)[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** Who placed the order: the rep who staged it (metadata.salesInitiatedById), else the member's own login. */
export function placedById(o: ReportOrder): string | null {
  return metadataString(o.metadata, 'salesInitiatedById') ?? o.partner?.userId ?? null;
}

// ─── Hierarchy ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface HierarchyCtx {
  clientId: string;
  /** The tenant's levels, LOWEST first (level 1 = field rep). */
  levels: LevelDef[];
  nodes: Map<string, SalesNode>;
}

/** Header for a level: the tenant's own level name, else the display label of its code (Bajaj labels). */
export function levelHeader(clientId: string, l: LevelDef): string {
  const n = (l.name ?? '').trim();
  return n || rungDisplayLabel(clientId, l.code);
}

export function hierarchyHeaders(ctx: Pick<HierarchyCtx, 'clientId' | 'levels'>): string[] {
  return ctx.levels.flatMap((l) => {
    const h = levelHeader(ctx.clientId, l);
    return [h, `${h} code`];
  });
}

export function isVacant(n: SalesNode): boolean {
  return !n.isActive || n.deletedAt != null || n.user?.status === 'INACTIVE';
}

/**
 * The [name, code] pair for every level, lowest first, from the outlet's assigned rep walking UP the reporting chain.
 *   • no assigned rep           → "Not assigned" in every cell;
 *   • a vacant post on the chain → "Vacant (CODE)" + its code;
 *   • a level the chain skips    → "—" (e.g. an ISR who reports straight to an ASM has no SO).
 * The FIRST node met for a level wins (cycle-safe, bounded by the node count).
 */
export function hierarchyCells(repId: string | null, ctx: HierarchyCtx): string[] {
  const rep = repId ? ctx.nodes.get(repId) : undefined;
  if (!rep) return ctx.levels.flatMap(() => [NOT_ASSIGNED, NOT_ASSIGNED]);
  const byLevel = new Map<string, SalesNode>();
  const seen = new Set<string>();
  let cur: SalesNode | undefined = rep;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (!byLevel.has(cur.hierarchyLevelId)) byLevel.set(cur.hierarchyLevelId, cur);
    cur = cur.reportingToId ? ctx.nodes.get(cur.reportingToId) : undefined;
  }
  return ctx.levels.flatMap((l) => {
    const n = byLevel.get(l.id);
    if (!n) return [NOT_APPLICABLE, NOT_APPLICABLE];
    if (isVacant(n)) return [`Vacant (${n.employeeCode})`, n.employeeCode];
    return [text(n.user?.name), n.employeeCode];
  });
}

// ─── Stages ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface StageCell {
  at: Date | null;
  /** The cell text for the time column when `at` is null ("Skipped" / "—" / "Not recorded"). */
  when: string;
  by: string;
}

export interface StageResult {
  placed: StageCell;
  confirmed: StageCell;
  processing: StageCell;
  dispatched: StageCell;
  delivered: StageCell;
  closed: StageCell;
  closedReason: string;
  /** When the order last entered its CURRENT status (null = unknown). */
  enteredCurrentAt: Date | null;
}

const rank = (s: RedemptionStatus) => HAPPY_STAGES.indexOf(s);

/**
 * Stage times from the status history: the FIRST time the order entered each status (a re-entered stage keeps its
 * first time). Missing history falls back to the order's own stamps (createdAt / dispatchedAt / deliveredAt /
 * cancelledAt — "by" then reads "Not recorded"). A happy-path stage the order went PAST without entering reads
 * "Skipped" when the order has history (a cash payout jumps Placed → Delivered), "Not recorded" when it has none.
 * `history` must be this order's rows sorted by createdAt, id ascending.
 */
export function resolveStages(o: ReportOrder, history: HistoryRow[], nameOf: (id: string | null) => string): StageResult {
  const first = new Map<RedemptionStatus, HistoryRow>();
  const last = new Map<RedemptionStatus, HistoryRow>();
  for (const h of history) {
    if (!first.has(h.toStatus)) first.set(h.toStatus, h);
    last.set(h.toStatus, h);
  }
  const hasHistory = history.length > 0;
  const actor = (h: HistoryRow) => (h.changedById ? nameOf(h.changedById) : SYSTEM);

  // How far along the happy path the order demonstrably got.
  let maxRank = rank(o.status);
  for (const h of history) maxRank = Math.max(maxRank, rank(h.toStatus));
  if (o.dispatchedAt) maxRank = Math.max(maxRank, rank('DISPATCHED'));
  if (o.deliveredAt) maxRank = Math.max(maxRank, rank('DELIVERED'));

  const fallback: Partial<Record<RedemptionStatus, Date | null>> = {
    DISPATCHED: o.dispatchedAt,
    DELIVERED: o.deliveredAt,
  };

  const stage = (s: RedemptionStatus): StageCell => {
    const h = first.get(s);
    if (h) return { at: h.createdAt, when: '', by: actor(h) };
    const fb = fallback[s];
    if (fb) return { at: fb, when: '', by: NOT_RECORDED };
    if (rank(s) < maxRank) return hasHistory ? { at: null, when: SKIPPED, by: NOT_APPLICABLE } : { at: null, when: NOT_RECORDED, by: NOT_RECORDED };
    if (rank(s) === maxRank && o.status === s) return { at: null, when: NOT_RECORDED, by: NOT_RECORDED };
    return { at: null, when: NOT_APPLICABLE, by: NOT_APPLICABLE };
  };

  const placedRow = first.get('PENDING');
  const placed: StageCell = { at: o.createdAt, when: '', by: placedRow?.changedById ? nameOf(placedRow.changedById) : nameOf(placedById(o)) };

  // Cancelled / Returned / Failed: the current end status if the order is in one, else the first end status it ever
  // entered (it may have been re-opened since).
  const endStatus: RedemptionStatus | undefined = END_STAGES.includes(o.status)
    ? o.status
    : history.find((h) => END_STAGES.includes(h.toStatus))?.toStatus;
  let closed: StageCell = { at: null, when: NOT_APPLICABLE, by: NOT_APPLICABLE };
  let closedReason = NOT_APPLICABLE;
  if (endStatus) {
    const h = first.get(endStatus);
    const at = h?.createdAt ?? (o.status === endStatus ? o.cancelledAt : null);
    const label = STATUS_LABEL[endStatus];
    closed = at
      ? { at, when: '', by: h ? actor(h) : NOT_RECORDED }
      : { at: null, when: `${label} — time ${NOT_RECORDED.toLowerCase()}`, by: NOT_RECORDED };
    closedReason = `${label}: ${text((o.status === endStatus ? o.cancelReason : null) ?? h?.notes)}`;
  }

  const stages = {
    placed,
    confirmed: stage('CONFIRMED'),
    processing: stage('PROCESSING'),
    dispatched: stage('DISPATCHED'),
    delivered: stage('DELIVERED'),
  };

  let enteredCurrentAt: Date | null = last.get(o.status)?.createdAt ?? null;
  if (!enteredCurrentAt) {
    if (o.status === 'PENDING') enteredCurrentAt = o.createdAt;
    else if (END_STAGES.includes(o.status)) enteredCurrentAt = closed.at;
    else enteredCurrentAt = stages[o.status.toLowerCase() as 'confirmed' | 'processing' | 'dispatched' | 'delivered']?.at ?? null;
  }

  return { ...stages, closed, closedReason, enteredCurrentAt };
}

const stageWhen = (c: StageCell): string => (c.at ? istDateTimeCell(c.at) : c.when);

// ─── Headers + one row ─────────────────────────────────────────────────────────────────────────────────────────

export const LEAD_HEADERS = [
  'Order no',
  'Redeemed on (IST)',
  'Reward',
  'Category',
  'Type',
  'Brand',
  'Quantity',
  'Points redeemed',
  'Value (₹)',
  'TDS deducted (₹)',
  'Current status',
  'Redeemed by',
  'Role',
  'Phone',
  'Outlet code',
  'Outlet name',
  'Outlet type',
  'Programme',
  'Sub-programme',
  'City',
  'State',
  'Zone',
] as const;

export const TAIL_HEADERS = [
  'Placed (IST)',
  'Placed by',
  'Confirmed (IST)',
  'Confirmed by',
  'Processing (IST)',
  'Processing by',
  'Dispatched (IST)',
  'Dispatched by',
  'Delivered (IST)',
  'Delivered by',
  'Cancelled/Returned/Failed (IST)',
  'Cancelled/Returned/Failed by',
  'Cancel/return/fail reason',
  'Days placed → delivered',
  'Days in current stage',
  'Fulfilled by',
  'Courier',
  'Tracking no',
  'Proof of delivery',
  'Delivery city',
  'Delivery state',
  'Delivery pincode',
  'Payout status',
  'Paid on (IST)',
  'Bank reference (UTR)',
] as const;

export function redemptionHeaders(ctx: Pick<HierarchyCtx, 'clientId' | 'levels'>): string[] {
  return [...LEAD_HEADERS, ...hierarchyHeaders(ctx), ...TAIL_HEADERS];
}

export interface RowInputs {
  order: ReportOrder;
  history: HistoryRow[];
  payout: PayoutRow | null;
  repId: string | null;
  /** Tenant display names for outlet types (OutletTypeClientConfig.displayName), by outletTypeId. */
  typeDisplay: Map<string, string>;
  nameOf: (id: string | null) => string;
  hierarchy: HierarchyCtx;
  now: Date;
}

/** Everything the Summary needs about one order (computed once with the row). */
export interface RowFacts {
  type: RedemptionRewardType;
  zone: string;
  state: string;
  reward: string;
  status: RedemptionStatus;
  points: number;
  valuePaise: bigint | null;
  daysToDeliver: number | null;
  hierarchy: string[];
}

function podCell(o: ReportOrder): XlsxCell {
  const url = (o.podUrl ?? '').trim();
  if (url) {
    if (/^https?:\/\//i.test(url)) return { __hyperlink: true, text: 'Yes — open', target: url } satisfies HyperlinkCell;
    return 'Yes (not a web link)';
  }
  return 'No';
}

function fulfilledBy(o: ReportOrder, type: RedemptionRewardType): string {
  if (o.fulfilledByVendor?.name) return o.fulfilledByVendor.name;
  if (type === 'E_VOUCHER') return o.voucherProvider?.trim() ? o.voucherProvider.trim() : NOT_RECORDED;
  if (type === 'CASH') return 'Gifsy (bank / UPI payout)';
  if (o.fulfilmentChannel === 'FULFILLED_BY_AMAZON') return 'Gifsy (via Amazon)';
  if (o.fulfilmentChannel === 'BRAND') return 'Brand (direct)';
  return 'Gifsy';
}

export function redemptionRow(inp: RowInputs): { cells: XlsxCell[]; facts: RowFacts } {
  const { order: o, payout } = inp;
  const outlet = outletOf(o);
  const type = rewardTypeOf(o);
  const stages = resolveStages(o, inp.history, inp.nameOf);
  const hier = hierarchyCells(inp.repId, inp.hierarchy);
  const physical = type === 'PHYSICAL_GIFT';

  const role = outlet
    ? inp.typeDisplay.get(outlet.outletTypeId) ||
      outlet.outletType?.name ||
      PARTNER_ROLE_LABEL[o.partner?.user?.role ?? ''] ||
      NOT_RECORDED
    : PARTNER_ROLE_LABEL[o.partner?.user?.role ?? ''] ?? NOT_RECORDED;

  const daysToDeliver = stages.delivered.at ? days(stages.delivered.at.getTime() - o.createdAt.getTime()) : null;

  // Cash payout bridge (PayoutTransaction): status / paid date / UTR. Not a cash order → "—".
  let payoutStatus = NOT_APPLICABLE;
  let paidOn = NOT_APPLICABLE;
  let utr = NOT_APPLICABLE;
  if (type === 'CASH') {
    if (!payout) payoutStatus = 'Not created yet';
    else {
      payoutStatus = PAYOUT_STATUS_LABEL[payout.status] ?? payout.status;
      if (payout.status === 'SUCCESS') {
        paidOn = payout.completedAt ? istDateTimeCell(payout.completedAt) : NOT_RECORDED;
        utr = text(payout.providerRefId);
      }
    }
  }

  const cells: XlsxCell[] = [
    o.orderNumber,
    istDateTimeCell(o.createdAt),
    text(o.reward?.name),
    text(o.reward?.category?.name),
    REWARD_TYPE_LABEL[type],
    brandOf(o.reward?.metadata),
    o.quantity,
    o.totalPointsCost,
    o.valuePaise != null ? inr(o.valuePaise) : NOT_SET,
    // Only TDS actually withheld from this order's cash payout. 194R on redemptions is client-borne → normally 0.
    payout ? inr(payout.tdsPaise) : 0,
    STATUS_LABEL[o.status] ?? o.status,
    text(o.partner?.ownerName ?? o.partner?.user?.name),
    role,
    maskPhone(o.partner?.phone),
    outlet ? outlet.outletCode : NOT_RECORDED,
    outlet ? text(outlet.name) : text(o.partner?.businessName),
    outlet ? text(outlet.outletType?.name) : NOT_RECORDED,
    text(outlet?.programName, NOT_SET),
    text(outlet?.programCategory, NOT_SET),
    text(outlet?.city),
    text(outlet?.state),
    text(outlet?.zone, NOT_SET),
    ...hier,
    stageWhen(stages.placed),
    stages.placed.by,
    stageWhen(stages.confirmed),
    stages.confirmed.by,
    stageWhen(stages.processing),
    stages.processing.by,
    stageWhen(stages.dispatched),
    stages.dispatched.by,
    stageWhen(stages.delivered),
    stages.delivered.by,
    stageWhen(stages.closed),
    stages.closed.by,
    stages.closedReason,
    daysToDeliver ?? 'Not delivered',
    stages.enteredCurrentAt ? days(inp.now.getTime() - stages.enteredCurrentAt.getTime()) : NOT_RECORDED,
    fulfilledBy(o, type),
    physical ? text(o.logisticsPartner) : NOT_APPLICABLE,
    physical ? text(o.trackingNumber) : NOT_APPLICABLE,
    physical ? podCell(o) : NOT_APPLICABLE,
    physical ? text(o.deliveryCity) : NOT_APPLICABLE,
    physical ? text(o.deliveryState) : NOT_APPLICABLE,
    physical ? text(o.deliveryPincode) : NOT_APPLICABLE,
    payoutStatus,
    paidOn,
    utr,
  ];

  return {
    cells,
    facts: {
      type,
      zone: text(outlet?.zone, NOT_SET),
      state: text(outlet?.state),
      reward: text(o.reward?.name),
      status: o.status,
      points: o.totalPointsCost,
      valuePaise: o.valuePaise,
      daysToDeliver,
      hierarchy: hier,
    },
  };
}

/** One "Status history" row. */
export const HISTORY_HEADERS = ['Order no', 'Outlet code', 'From', 'To', 'When (IST)', 'By', 'Notes'] as const;

export function historyRow(h: HistoryRow, orderNumber: string, outletCode: string, nameOf: (id: string | null) => string): XlsxCell[] {
  return [
    orderNumber,
    outletCode,
    h.fromStatus ? STATUS_LABEL[h.fromStatus] : NOT_RECORDED,
    STATUS_LABEL[h.toStatus] ?? h.toStatus,
    istDateTimeCell(h.createdAt),
    h.changedById ? nameOf(h.changedById) : SYSTEM,
    text(h.notes, NOT_APPLICABLE),
  ];
}

// ─── Summary ───────────────────────────────────────────────────────────────────────────────────────────────────

interface Bucket {
  orders: number;
  points: number;
  valuePaise: bigint;
  livePoints: number;
  liveValuePaise: bigint;
  delivered: number;
  /** Delivered orders whose delivery time is known (the average's denominator). */
  timed: number;
  deliverDays: number;
}

const emptyBucket = (): Bucket => ({ orders: 0, points: 0, valuePaise: 0n, livePoints: 0, liveValuePaise: 0n, delivered: 0, timed: 0, deliverDays: 0 });

export const SUMMARY_HEADERS = [
  'Section',
  'Group',
  'Orders',
  'Points (all orders)',
  'Value ₹ (all orders)',
  'Points (confirmed to delivered)',
  'Value ₹ (confirmed to delivered)',
  'Delivered orders',
  'Avg days placed → delivered',
] as const;

export class RedemptionSummary {
  private readonly sections = new Map<string, Map<string, Bucket>>();
  private readonly total = emptyBucket();

  /** `asmIndex` = the position of the ASM-level NAME cell inside RowFacts.hierarchy (null = tenant has no ASM level). */
  constructor(
    private readonly asmLabel: string | null,
    private readonly asmIndex: number | null,
  ) {}

  private bump(section: string, group: string, f: RowFacts): void {
    let s = this.sections.get(section);
    if (!s) this.sections.set(section, (s = new Map()));
    let b = s.get(group);
    if (!b) s.set(group, (b = emptyBucket()));
    this.addTo(b, f);
  }

  private addTo(b: Bucket, f: RowFacts): void {
    b.orders++;
    b.points += f.points;
    b.valuePaise += f.valuePaise ?? 0n;
    if (LIVE_STATUSES.includes(f.status)) {
      b.livePoints += f.points;
      b.liveValuePaise += f.valuePaise ?? 0n;
    }
    if (f.status === 'DELIVERED') b.delivered++;
    if (f.daysToDeliver != null) {
      b.timed++;
      b.deliverDays += f.daysToDeliver;
    }
  }

  add(f: RowFacts): void {
    this.addTo(this.total, f);
    this.bump('By zone', f.zone, f);
    this.bump('By state', f.state, f);
    if (this.asmIndex != null) {
      const name = f.hierarchy[this.asmIndex];
      const code = f.hierarchy[this.asmIndex + 1];
      const group = name === code || name.startsWith('Vacant') || code === NOT_APPLICABLE || code === NOT_ASSIGNED ? name : `${name} (${code})`;
      this.bump(`By ${this.asmLabel}`, group, f);
    }
    this.bump('By reward', f.reward, f);
    this.bump('By status', STATUS_LABEL[f.status], f);
    this.bump('By reward type', REWARD_TYPE_LABEL[f.type], f);
    const stage = f.status === 'DELIVERED' ? 'Delivered' : END_STAGES.includes(f.status) ? 'Closed without delivery' : 'Pending (placed to dispatched)';
    this.bump('Delivery', stage, f);
  }

  private line(section: string, group: string, b: Bucket): XlsxCell[] {
    return [
      section,
      group,
      b.orders,
      b.points,
      inr(b.valuePaise),
      b.livePoints,
      inr(b.liveValuePaise),
      b.delivered,
      b.timed ? Math.round((b.deliverDays / b.timed) * 10) / 10 : NOT_APPLICABLE,
    ];
  }

  rows(): XlsxCell[][] {
    const out: XlsxCell[][] = [this.line('Total', 'All orders in this file', this.total)];
    for (const [section, groups] of this.sections) {
      const sorted = [...groups.entries()].sort((a, b) => b[1].points - a[1].points || a[0].localeCompare(b[0]));
      for (const [g, b] of sorted) out.push(this.line(section, g, b));
    }
    return out;
  }
}
