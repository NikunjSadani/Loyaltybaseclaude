/* ─── Gift dispatch / fulfilment — pure types + business logic ─────────────────
 *
 * Everything here is PURE (no fetch, no DOM, no localStorage) so the console's
 * status-transition guard, the fulfilment-payload builder, the list-filter query
 * builder, and the status timeline are all straightforwardly unit-testable. The
 * side-effectful adapters (fetch, xlsx download) live in the pages that call these.
 *
 * Contract mirrors platform/docs/plans/GIFT-CATALOGUE-AND-DISPATCH-DESIGN.md §5 / §2.
 * Endpoints consumed by the Gifsy fulfilment console (FE `/api/*` → backend `/v1/*`):
 *   GET   /api/admin/gift-orders                 (cross-tenant list + filter → { items })
 *   GET   /api/admin/gift-orders/:id             (detail → flat object)
 *   PATCH /api/admin/gift-orders/:id/fulfilment  (set channel / partner / tracking / refs)
 *   POST  /api/admin/gift-orders/:id/transition  (guarded edge-map, incl. Gifsy-only RETURNED)
 *   GET   /api/admin/rewards/fulfilment/template (xlsx blob — reused bulk sheet)
 *   POST  /api/admin/rewards/fulfilment/upload   (multipart "file" — reused bulk upload)
 * ─────────────────────────────────────────────────────────────────────────── */

// ─── Status + channel enums ───────────────────────────────────────────────────

export type GiftOrderStatus =
  | 'PENDING'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'DISPATCHED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'RETURNED'
  | 'FAILED'
  | 'REVERSED';

/** Fulfilment channels (design §10). DIGITAL_VOUCHER exposes no shipping PII. */
export type GiftFulfilmentChannel =
  | 'FULFILLED_BY_AMAZON'
  | 'GIFSY_WAREHOUSE'
  | 'BRAND'
  | 'DIGITAL_VOUCHER';

export const GIFT_ORDER_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  PROCESSING: 'Processing',
  DISPATCHED: 'Dispatched',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  RETURNED: 'Returned',
  FAILED: 'Failed',
  REVERSED: 'Reversed',
};

/** Tailwind pill classes per status (mirrors the reward-catalogue fulfilment table). */
export const GIFT_ORDER_STATUS_BADGE: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700 border-amber-100',
  CONFIRMED: 'bg-blue-50 text-blue-700 border-blue-100',
  PROCESSING: 'bg-blue-50 text-blue-700 border-blue-100',
  DISPATCHED: 'bg-indigo-50 text-indigo-700 border-indigo-100',
  DELIVERED: 'bg-green-50 text-green-700 border-green-100',
  CANCELLED: 'bg-red-50 text-red-600 border-red-100',
  RETURNED: 'bg-orange-50 text-orange-700 border-orange-100',
  FAILED: 'bg-red-50 text-red-600 border-red-100',
  REVERSED: 'bg-gray-50 text-gray-500 border-gray-200',
};

export function statusLabel(status: string): string {
  return GIFT_ORDER_STATUS_LABEL[status] ?? status;
}

export function statusBadgeClass(status: string): string {
  return GIFT_ORDER_STATUS_BADGE[status] ?? GIFT_ORDER_STATUS_BADGE.REVERSED;
}

export const GIFT_FULFILMENT_CHANNELS: { value: GiftFulfilmentChannel; label: string }[] = [
  { value: 'FULFILLED_BY_AMAZON', label: 'Fulfilled by Amazon' },
  { value: 'GIFSY_WAREHOUSE', label: 'Gifsy warehouse' },
  { value: 'BRAND', label: 'Brand / supplier' },
  { value: 'DIGITAL_VOUCHER', label: 'Digital voucher' },
];

export function channelLabel(value?: string | null): string {
  if (!value) return '—';
  return GIFT_FULFILMENT_CHANNELS.find((c) => c.value === value)?.label ?? value;
}

/** A digital voucher ships no physical parcel — the fulfilment form asks for a code, not tracking. */
export function isVoucherChannel(channel?: string | null): boolean {
  return channel === 'DIGITAL_VOUCHER';
}

// ─── Transition edge-map (Gifsy ops console — sees + acts on ALL tenants) ──────

/**
 * Guarded next-status options keyed by current status. The Gifsy ops console is the
 * platform-wide oversight surface, so it owns EVERY edge including the wallet-touching
 * ones (CANCELLED / FAILED refund) and the Gifsy-only value-reversal DELIVERED→RETURNED
 * (§12: zeroes valuePaise + refunds points so 194R + the disbursal report don't over-count).
 * A vendor-facing surface (out of scope here) would use a RESTRICTED subset with no
 * wallet-touching edge — see the design doc.
 */
export const CONSOLE_NEXT_STATUS: Record<string, GiftOrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['DISPATCHED', 'FAILED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED', 'RETURNED'],
  DELIVERED: ['RETURNED'],
  // CANCELLED / RETURNED / FAILED / REVERSED are terminal → no outgoing edges.
};

export function nextStatusOptions(status?: string | null): GiftOrderStatus[] {
  if (!status) return [];
  return CONSOLE_NEXT_STATUS[status] ?? [];
}

export function isTerminalStatus(status?: string | null): boolean {
  return nextStatusOptions(status).length === 0;
}

/** True when a transition can be legally made from `from` to `to`. */
export function canTransition(from: string, to: string): boolean {
  return nextStatusOptions(from).includes(to as GiftOrderStatus);
}

/**
 * Wallet-/value-touching transitions. RETURNED reverses a delivered order's value
 * (194R + disbursal), CANCELLED / FAILED refund the member's points. These get a
 * stronger, explicit confirmation than a routine forward step.
 */
export function isWalletTouching(to: string): boolean {
  return to === 'RETURNED' || to === 'CANCELLED' || to === 'FAILED' || to === 'REVERSED';
}

/** A DELIVERED→RETURNED step is the Gifsy-only value-reversal edge. */
export function isReversal(from: string, to: string): boolean {
  return from === 'DELIVERED' && to === 'RETURNED';
}

export interface ConfirmCopy {
  title: string;
  description: string;
  danger: boolean;
  confirmLabel: string;
}

/**
 * Confirmation copy for a status change. Every status change confirms (task: "Confirm
 * on status changes"); the wallet-/value-touching ones carry an honest, specific
 * warning about the irreversible money/tax effect rather than a generic "are you sure".
 */
export function confirmCopyFor(from: string, to: string): ConfirmCopy {
  const toLabel = statusLabel(to);
  if (isReversal(from, to)) {
    return {
      title: 'Reverse this delivered order?',
      description:
        'Marking a DELIVERED order as Returned reverses its value — it zeroes the order value used by 194R and the gift-disbursal report, and refunds the member per policy. This cannot be undone from here.',
      danger: true,
      confirmLabel: 'Confirm return',
    };
  }
  if (to === 'CANCELLED') {
    return {
      title: 'Cancel this order?',
      description:
        "Cancelling refunds the member's points to their wallet. This cannot be undone.",
      danger: true,
      confirmLabel: 'Cancel order',
    };
  }
  if (to === 'FAILED') {
    return {
      title: 'Mark this order failed?',
      description:
        "Marking the order failed refunds the member's points per policy. This cannot be undone.",
      danger: true,
      confirmLabel: 'Mark failed',
    };
  }
  return {
    title: `Advance order to ${toLabel}?`,
    description: `This moves the order to ${toLabel} and notifies the member where applicable.`,
    danger: false,
    confirmLabel: `Confirm → ${toLabel}`,
  };
}

// ─── List filters → query string ──────────────────────────────────────────────

export interface GiftOrderFilters {
  /** Tenant clientId; '' / undefined = all tenants. */
  clientId?: string;
  status?: string;
  channel?: string;
  /** Free-text order-number search. */
  q?: string;
  /** ISO date (yyyy-mm-dd) inclusive lower / upper bound on createdAt. */
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export function emptyGiftOrderFilters(): GiftOrderFilters {
  return { clientId: '', status: 'all', channel: 'all', q: '', from: '', to: '' };
}

/** True when no filter narrows the list (everything at defaults). */
export function isFiltersEmpty(f: GiftOrderFilters): boolean {
  return (
    !f.clientId &&
    (!f.status || f.status === 'all') &&
    (!f.channel || f.channel === 'all') &&
    !f.q?.trim() &&
    !f.from &&
    !f.to
  );
}

/**
 * Build the `GET /api/admin/gift-orders` query string from the filter state. Only
 * active constraints are emitted; the 'all' sentinel for status/channel is dropped.
 * Returns a leading '?' when any param is present, else ''.
 */
export function buildListQuery(f: GiftOrderFilters): string {
  const params = new URLSearchParams();
  if (f.clientId) params.set('clientId', f.clientId);
  if (f.status && f.status !== 'all') params.set('status', f.status);
  if (f.channel && f.channel !== 'all') params.set('channel', f.channel);
  if (f.q && f.q.trim()) params.set('q', f.q.trim());
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  params.set('page', String(f.page ?? 1));
  params.set('limit', String(f.limit ?? 100));
  const s = params.toString();
  return s ? `?${s}` : '';
}

// ─── Fulfilment payload builder ────────────────────────────────────────────────

export interface FulfilmentDraft {
  fulfilmentChannel: string;
  logisticsPartner: string;
  trackingNumber: string;
  trackingUrl: string;
  supplierOrderRef: string;
  voucherCode: string;
  voucherProvider: string;
}

export function emptyFulfilmentDraft(order?: Partial<GiftOrderDetail>): FulfilmentDraft {
  return {
    fulfilmentChannel: order?.fulfilmentChannel ?? '',
    logisticsPartner: order?.logisticsPartner ?? '',
    trackingNumber: order?.trackingNumber ?? '',
    trackingUrl: order?.trackingUrl ?? '',
    supplierOrderRef: order?.supplierOrderRef ?? '',
    voucherCode: order?.voucherCode ?? '',
    voucherProvider: order?.voucherProvider ?? '',
  };
}

export interface FulfilmentValidation {
  ok: boolean;
  error?: string;
}

/**
 * A fulfilment update needs at minimum a channel. A physical channel should carry a
 * tracking number OR a supplier order ref; a digital voucher should carry a code. We
 * WARN (not hard-block beyond the channel) so an operator can save a channel first
 * and add tracking later — the backend remains the source of truth.
 */
export function validateFulfilment(d: FulfilmentDraft): FulfilmentValidation {
  if (!d.fulfilmentChannel) return { ok: false, error: 'Pick a fulfilment channel.' };
  return { ok: true };
}

/**
 * When the channel toggles between a physical channel and DIGITAL_VOUCHER, the
 * non-applicable fields must be cleared so we never persist (and show the member) a
 * stale tracking number under a new voucher code, or vice-versa. Pure so the toggle
 * handler + a unit test can share it.
 */
export function resetNonApplicableFields(d: FulfilmentDraft): FulfilmentDraft {
  if (isVoucherChannel(d.fulfilmentChannel)) {
    // Digital voucher ships no parcel — drop all shipping fields.
    return { ...d, logisticsPartner: '', trackingNumber: '', trackingUrl: '', supplierOrderRef: '' };
  }
  // A physical channel carries no voucher — drop voucher fields.
  return { ...d, voucherCode: '', voucherProvider: '' };
}

/**
 * Build the PATCH /fulfilment body. We send the FULL editable field set every time —
 * a field the operator blanked is sent as `null` so the backend clears it (a stale
 * tracking number must be correctable, not silently retained). `null` (not `''`) is
 * used so it passes the backend's `@IsOptional() @IsUrl()` on trackingUrl and clears
 * the nullable column; empty strings would trip URL validation. The channel is always
 * present (validation requires it).
 */
export function buildFulfilmentPayload(d: FulfilmentDraft): Record<string, unknown> {
  const orNull = (s: string) => {
    const t = s.trim();
    return t === '' ? null : t;
  };
  return {
    fulfilmentChannel: d.fulfilmentChannel || null,
    logisticsPartner: orNull(d.logisticsPartner),
    trackingNumber: orNull(d.trackingNumber),
    trackingUrl: orNull(d.trackingUrl),
    supplierOrderRef: orNull(d.supplierOrderRef),
    voucherCode: orNull(d.voucherCode),
    voucherProvider: orNull(d.voucherProvider),
  };
}

// ─── Order shapes ──────────────────────────────────────────────────────────────

export interface GiftOrderSummary {
  id: string;
  orderNumber?: string | null;
  /** Owning tenant — for the cross-tenant console list + tenant filter. */
  clientId?: string | null;
  tenantName?: string | null;
  status: string;
  redemptionMode?: string | null;
  fulfilmentChannel?: string | null;
  rewardName?: string | null;
  partnerName?: string | null;
  totalPointsCost?: number | null;
  valuePaise?: number | null;
  trackingNumber?: string | null;
  createdAt: string;
  updatedAt?: string | null;
}

export interface StatusHistoryEntry {
  status: string;
  at: string;
  note?: string | null;
  byName?: string | null;
}

export interface GiftOrderDetail extends GiftOrderSummary {
  trackingUrl?: string | null;
  supplierOrderRef?: string | null;
  voucherCode?: string | null;
  voucherProvider?: string | null;
  logisticsPartner?: string | null;
  /** Internal "fulfilled by" — ops/tenant only, never shown on the member tile. */
  fulfilledByVendorId?: string | null;
  fulfilledByVendorName?: string | null;
  /** Shipping PII (physical channels only) — ops-visible for support/disputes. */
  delivery?: {
    name?: string | null;
    address?: string | null;
    phone?: string | null;
  } | null;
  statusHistory?: StatusHistoryEntry[] | null;
  confirmedAt?: string | null;
  processedAt?: string | null;
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  returnedAt?: string | null;
}

export interface TimelineStep {
  status: string;
  date: string;
  note?: string;
}

/**
 * Build a status timeline for the detail view. Prefers the backend `statusHistory`
 * (authoritative, ordered, with actor + note); falls back to the stamped timestamps
 * when history is absent so the timeline is never empty for a progressed order.
 */
export function buildTimeline(o: GiftOrderDetail): TimelineStep[] {
  if (o.statusHistory && o.statusHistory.length > 0) {
    return o.statusHistory
      .slice()
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
      .map((h) => ({
        status: statusLabel(h.status),
        date: h.at,
        note: [h.note, h.byName ? `by ${h.byName}` : null].filter(Boolean).join(' · ') || undefined,
      }));
  }
  const steps: TimelineStep[] = [{ status: 'Order placed', date: o.createdAt }];
  if (o.confirmedAt) steps.push({ status: 'Confirmed', date: o.confirmedAt });
  if (o.processedAt) steps.push({ status: 'Processing', date: o.processedAt });
  if (o.dispatchedAt) {
    steps.push({
      status: 'Dispatched',
      date: o.dispatchedAt,
      note: o.trackingNumber ? `Tracking: ${o.trackingNumber}` : undefined,
    });
  }
  if (o.deliveredAt) steps.push({ status: 'Delivered', date: o.deliveredAt });
  if (o.returnedAt) steps.push({ status: 'Returned', date: o.returnedAt });
  if (o.cancelledAt) steps.push({ status: 'Cancelled', date: o.cancelledAt });
  if (steps.length === 1 && o.status !== 'PENDING') {
    steps.push({ status: statusLabel(o.status), date: o.updatedAt ?? o.createdAt });
  }
  return steps;
}

// ─── Formatting helpers ────────────────────────────────────────────────────────

export function fmtValuePaise(p?: number | null): string {
  if (p == null) return '—';
  return `₹${(p / 100).toLocaleString('en-IN')}`;
}

export function fmtPoints(n?: number | null): string {
  if (n == null) return '—';
  return n.toLocaleString('en-IN');
}
