import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PayoutMode, Prisma, RedemptionStatus } from '@prisma/client';

/**
 * VOUCHER WRITE INVARIANT (owner money rule) — the ONE server-side gate every MANUAL voucher write
 * goes through (rewards updateOrder + transitionOrder — hence the bulk fulfilment upload and the
 * gift-catalogue dispatch controller — and the vendor portal updateFulfilment + transition):
 *
 *   A stored voucher code can never be cleared or replaced, except by
 *   POST /rewards/orders/:id/voucher-cancelled ("Voucher cancelled with vendor").
 *
 * Concretely, for an incoming voucherCode / voucherProvider (compared TRIMMED):
 *  - omitted (undefined)        → no change;
 *  - null / blank after trim    → 400 (a "clear" is never a write — it would lift the refund block);
 *  - identical to the stored    → no-op (an idempotent re-send, e.g. a re-uploaded filled sheet);
 *  - a Hubble-managed order     → 400 for ANY change (stored provider 'Hubble' in any case, a Hubble
 *    marker in metadata — hubbleStatus / hubbleOrderId / hubbleNeedsReconcile / hubbleVoucher — or
 *    Hubble-eligible per the caller); 'Hubble' is never hand-set;
 *  - a cash redemption (UPI / BANK_TRANSFER) → 400 (cash never carries a voucher code);
 *  - a code when one is stored  → 400 (no overwrite); a provider change then counts as one too;
 *  - a code previously cancelled with the vendor on this order (sha256 in metadata) → 400;
 *  - a NEW code only on a paid, open order: CONFIRMED / PROCESSING / DISPATCHED with
 *    pointsDeducted > 0 — and the write is a compare-and-set on exactly that, the provider read
 *    and the row's updatedAt, so ANY concurrent write (refund, vendor-cancel, other edit) makes it
 *    lose (0 rows → 409). That also stops a stale request resurrecting a just-cancelled code.
 */

export const VOUCHER_WRITABLE_STATUSES: readonly RedemptionStatus[] = [
  RedemptionStatus.CONFIRMED,
  RedemptionStatus.PROCESSING,
  RedemptionStatus.DISPATCHED,
];

/** Backend cash payout modes — mirrors the CASH set transitionOrder / payouts use. */
export const CASH_PAYOUT_MODES: ReadonlySet<string> = new Set([PayoutMode.UPI, PayoutMode.BANK_TRANSFER]);

export const VOUCHER_ALREADY_ISSUED_MESSAGE =
  "A voucher code is already issued; use 'Voucher cancelled with vendor' first.";
export const VOUCHER_BLANK_MESSAGE =
  "A voucher code / provider can't be cleared or blank — use 'Voucher cancelled with vendor' to cancel an issued code.";
export const VOUCHER_STATUS_MESSAGE =
  'A voucher code can only be issued on a confirmed, paid order (CONFIRMED / PROCESSING / DISPATCHED).';
export const HUBBLE_PROVIDER_MESSAGE =
  'This order is fulfilled by the Hubble integration — its voucher fields cannot be set or changed by hand.';
export const VOUCHER_CASH_MESSAGE = 'A cash redemption cannot carry a voucher code.';
export const VOUCHER_REUSED_MESSAGE =
  "This voucher code was cancelled with the vendor and can't be reused.";
export const VOUCHER_WRITE_CONFLICT_MESSAGE = 'The order changed — refresh and try again.';

/** metadata key holding sha256 hashes of codes cleared by "Voucher cancelled with vendor". */
export const CANCELLED_VOUCHER_HASHES_KEY = 'cancelledVoucherCodeHashes';

export interface VoucherWriteInput {
  voucherCode?: string | null;
  voucherProvider?: string | null;
}

export interface VoucherOrderState {
  status: RedemptionStatus | string;
  voucherCode: string | null;
  voucherProvider: string | null;
  pointsDeducted: number;
  redemptionMode?: PayoutMode | string | null;
  metadata?: Prisma.JsonValue | null;
  updatedAt?: Date | null;
}

export interface VoucherWritePlan {
  /** Only the voucher columns that actually change (trimmed). Spread into the write's `data`. */
  data: { voucherCode?: string; voucherProvider?: string };
  /** Claim predicate to AND into the write's `where` (null = no voucher write → no extra guard). */
  guard: Prisma.RedemptionOrderWhereInput | null;
  /** True when this write sets a NEW code (caller audits + notifies the member). */
  issuesNewCode: boolean;
}

/** sha256 of the trimmed code — what we keep for cancelled codes (never the code itself). */
export function hashVoucherCode(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

const isBlank = (v: string | null | undefined) => v === null || (typeof v === 'string' && v.trim() === '');
const norm = (v: string | null | undefined) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t === '' ? null : t;
};
const isHubbleProvider = (v: string | null | undefined) => (norm(v) ?? '').toLowerCase() === 'hubble';
const metaObj = (m: Prisma.JsonValue | null | undefined): Record<string, unknown> =>
  m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};

/** Hubble markers placeOrder / markHubbleProcessing / markHubblePendingReconcile leave on an order. */
export function hasHubbleMarkers(order: Pick<VoucherOrderState, 'voucherProvider' | 'metadata'>): boolean {
  if (isHubbleProvider(order.voucherProvider)) return true;
  const m = metaObj(order.metadata);
  return (
    m.hubbleNeedsReconcile === true ||
    m.hubbleStatus != null ||
    m.hubbleOrderId != null ||
    m.hubbleVoucher != null ||
    m.hubbleReconcileReason != null
  );
}

/** The cancelled-code hashes recorded on the order. */
export function cancelledVoucherHashes(metadata: Prisma.JsonValue | null | undefined): string[] {
  const v = metaObj(metadata)[CANCELLED_VOUCHER_HASHES_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Validate + plan the voucher part of a MANUAL write against the order as READ. Throws 400 on a
 * rule violation; returns the columns to write and the CAS predicate the write must carry.
 * `hubbleEligible` = the caller's async isHubbleManagedOrder() result (pass it whenever voucher
 * fields are present; markers on the row are checked here regardless).
 */
export function planVoucherWrite(
  order: VoucherOrderState,
  input: VoucherWriteInput,
  opts: { hubbleEligible?: boolean } = {},
): VoucherWritePlan {
  const data: VoucherWritePlan['data'] = {};
  const none: VoucherWritePlan = { data, guard: null, issuesNewCode: false };
  if (input.voucherCode === undefined && input.voucherProvider === undefined) return none;

  if (input.voucherCode !== undefined && isBlank(input.voucherCode)) throw new BadRequestException(VOUCHER_BLANK_MESSAGE);
  if (input.voucherProvider !== undefined && isBlank(input.voucherProvider)) throw new BadRequestException(VOUCHER_BLANK_MESSAGE);

  const storedCode = norm(order.voucherCode);
  const storedProvider = norm(order.voucherProvider);
  const code = input.voucherCode === undefined ? undefined : norm(input.voucherCode)!;
  const provider = input.voucherProvider === undefined ? undefined : norm(input.voucherProvider)!;

  const codeChanges = code !== undefined && code !== storedCode;
  const providerChanges = provider !== undefined && provider !== storedProvider;
  if (!codeChanges && !providerChanges) return none; // idempotent re-send (trimmed compare)

  // Hubble-managed: the integration owns the voucher — no manual write of any kind.
  if (isHubbleProvider(provider) || hasHubbleMarkers(order) || opts.hubbleEligible) {
    throw new BadRequestException(HUBBLE_PROVIDER_MESSAGE);
  }
  // Cash settles via the payout rail — never a voucher code.
  if (order.redemptionMode && CASH_PAYOUT_MODES.has(order.redemptionMode)) {
    throw new BadRequestException(VOUCHER_CASH_MESSAGE);
  }
  // Anything that changes the voucher on an order that already holds a code is a replace.
  if (storedCode !== null) throw new BadRequestException(VOUCHER_ALREADY_ISSUED_MESSAGE);
  if (codeChanges && cancelledVoucherHashes(order.metadata).includes(hashVoucherCode(code!))) {
    throw new BadRequestException(VOUCHER_REUSED_MESSAGE);
  }
  if (!VOUCHER_WRITABLE_STATUSES.includes(order.status as RedemptionStatus) || !(order.pointsDeducted > 0)) {
    throw new BadRequestException(VOUCHER_STATUS_MESSAGE);
  }

  if (codeChanges) data.voucherCode = code;
  if (providerChanges) data.voucherProvider = provider;
  const and: Prisma.RedemptionOrderWhereInput[] = [
    { OR: [{ voucherCode: null }, { voucherCode: '' }] },
    { status: { in: [...VOUCHER_WRITABLE_STATUSES] } },
    { pointsDeducted: { gt: 0 } },
    // The provider read is part of the claim too (a concurrent Hubble stamp loses).
    order.voucherProvider == null
      ? { OR: [{ voucherProvider: null }, { voucherProvider: '' }] }
      : { voucherProvider: order.voucherProvider },
  ];
  // Optimistic lock on the row version as read: ANY write in between (a vendor-cancel that
  // records the cancelled hash, a refund, a Hubble stamp) bumps @updatedAt → this write loses.
  if (order.updatedAt) and.push({ updatedAt: order.updatedAt });
  return { data, guard: { AND: and }, issuesNewCode: codeChanges };
}

/**
 * Async half of the Hubble check: markers on the row, else GIFT_CARD + a hubbleProductId on the
 * catalogue item + the item's tenant flag ON (the same eligibility isHubbleEligible uses). Only
 * reads the DB for a GIFT_CARD order without markers.
 */
export async function isHubbleManagedOrder(
  db: {
    rewardCatalog: { findFirst: (args: Prisma.RewardCatalogFindFirstArgs) => Promise<unknown> };
    client: { findFirst: (args: Prisma.ClientFindFirstArgs) => Promise<unknown> };
  },
  order: Pick<VoucherOrderState, 'voucherProvider' | 'metadata' | 'redemptionMode'> & { rewardId?: string | null },
): Promise<boolean> {
  if (hasHubbleMarkers(order)) return true;
  if (order.redemptionMode !== PayoutMode.GIFT_CARD || !order.rewardId) return false;
  const reward = (await db.rewardCatalog.findFirst({
    where: { id: order.rewardId },
    select: { metadata: true, clientId: true },
  })) as { metadata?: Prisma.JsonValue; clientId?: string } | null;
  const pid = metaObj(reward?.metadata ?? null).hubbleProductId;
  if (typeof pid !== 'string' || !pid.trim() || !reward?.clientId) return false;
  const client = (await db.client.findFirst({
    where: { id: reward.clientId },
    select: { features: true },
  })) as { features?: unknown } | null;
  return (client?.features as Record<string, unknown> | null)?.hubbleVoucherEnabled === true;
}

/** AND together optional claim predicates (undefined when there are none). */
export function combineGuards(
  ...guards: (Prisma.RedemptionOrderWhereInput | null | undefined)[]
): Prisma.RedemptionOrderWhereInput | undefined {
  const present = guards.filter((g): g is Prisma.RedemptionOrderWhereInput => !!g);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { AND: present };
}
