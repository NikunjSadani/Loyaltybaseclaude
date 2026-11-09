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
 *  - 'Hubble' is never hand-set as a provider;
 *  - an order HANDED TO HUBBLE (a Hubble marker: provider 'Hubble' in any case, hubbleStatus /
 *    hubbleOrderId / hubbleNeedsReconcile / hubbleReconcileReason / hubbleVoucher in metadata) →
 *    400, UNLESS a GIFSY_ADMIN sends an explicit, reasoned MANUAL OVERRIDE (the ops exit for a
 *    stuck Hubble order) — which still obeys every rule below. Merely being Hubble-eligible (the
 *    tenant flag turned on later) does NOT block: only an order that actually went to Hubble;
 *  - a cash redemption (UPI / BANK_TRANSFER) → 400 (cash never carries a voucher code);
 *  - a code when one is stored  → 400 (no overwrite); a provider change then counts as one too;
 *  - a code cancelled with the vendor ANYWHERE in the tenant (normalised sha256 in
 *    cancelled_voucher_codes — the caller looks it up) → 400;
 *  - a NEW code only on a paid, open order: CONFIRMED / PROCESSING / DISPATCHED with
 *    pointsDeducted > 0 — and the write is a compare-and-set on exactly that, the provider read
 *    and the row's updatedAt, so ANY concurrent write (refund, vendor-cancel, other edit) makes it
 *    lose (0 rows → 409).
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
  "This order was sent to the Hubble integration — retry with Hubble, or a Gifsy admin can 'Fulfil manually' with a reason.";
export const HUBBLE_HAND_SET_MESSAGE = "The 'Hubble' provider is set by the integration only.";
export const VOUCHER_CASH_MESSAGE = 'A cash redemption cannot carry a voucher code.';
export const VOUCHER_REUSED_MESSAGE =
  "This voucher code was cancelled with the vendor and can't be reused.";
export const VOUCHER_WRITE_CONFLICT_MESSAGE = 'The order changed — refresh and try again.';
export const OVERRIDE_NOT_NEEDED_MESSAGE =
  'Manual fulfilment override is only for orders that were sent to Hubble.';
export const OVERRIDE_NEEDS_CODE_MESSAGE = 'A manual fulfilment override must set a voucher code.';
export const OVERRIDE_REASON_MESSAGE = 'A reason is required for a manual fulfilment override.';

/** Default provider label for a manual override that names none. */
export const MANUAL_OVERRIDE_PROVIDER = 'Manual';

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

export interface VoucherWriteOptions {
  /** The caller's tenant-wide lookup: is the incoming code a previously cancelled one? */
  cancelledCodeReused?: boolean;
  /** A GIFSY_ADMIN's explicit, reasoned manual fulfilment of a Hubble-handed order. */
  manualOverride?: { reason: string; actorId: string; at: Date } | null;
}

export interface VoucherWritePlan {
  /** Only the columns that actually change. Spread into the write's `data`. */
  data: { voucherCode?: string; voucherProvider?: string; metadata?: Prisma.InputJsonValue };
  /** Claim predicate to AND into the write's `where` (null = no voucher write → no extra guard). */
  guard: Prisma.RedemptionOrderWhereInput | null;
  /** True when this write sets a NEW code (caller audits + notifies the member). */
  issuesNewCode: boolean;
  /** True when this write is a manual override of a Hubble-handed order. */
  overridden: boolean;
}

/** Normalise a code for the reuse hash: trim, uppercase, strip ALL whitespace. */
export function normaliseVoucherCode(code: string): string {
  return code.replace(/\s+/g, '').toUpperCase();
}

/** sha256 of the NORMALISED code — what we keep for cancelled codes (never the code itself). */
export function hashVoucherCode(code: string): string {
  return createHash('sha256').update(normaliseVoucherCode(code)).digest('hex');
}

const isBlank = (v: string | null | undefined) => v === null || (typeof v === 'string' && v.trim() === '');
const norm = (v: string | null | undefined) => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t === '' ? null : t;
};
export const isHubbleProvider = (v: string | null | undefined) => (norm(v) ?? '').toLowerCase() === 'hubble';
const metaObj = (m: Prisma.JsonValue | null | undefined): Record<string, unknown> =>
  m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};

/** The order was handed to Hubble (placeOrder / markHubbleProcessing / reconcile flags). */
export function hasHubbleMarkers(order: { voucherProvider?: string | null; metadata?: Prisma.JsonValue | null }): boolean {
  if (isHubbleProvider(order.voucherProvider)) return true;
  const m = metaObj(order.metadata);
  // Ops took it over (manual override) or released it (Hubble definitively failed and the manual
  // code was cancelled with the vendor) — audited; it is a plain order from here on.
  if (m.hubbleStatus === 'MANUAL_OVERRIDE' || m.hubbleStatus === 'RELEASED') return false;
  return (
    m.hubbleNeedsReconcile === true ||
    m.hubbleStatus != null ||
    m.hubbleOrderId != null ||
    m.hubbleVoucher != null ||
    m.hubbleReconcileReason != null
  );
}

/**
 * The stored code was ISSUED BY HUBBLE (a real Amazon voucher Hubble can't claw back) — as opposed
 * to a manual code sitting on an order whose only Hubble trace is an ops flag.
 */
export function isHubbleIssuedCode(order: {
  voucherCode?: string | null;
  voucherProvider?: string | null;
  metadata?: Prisma.JsonValue | null;
}): boolean {
  if (norm(order.voucherCode) === null) return false;
  if (isHubbleProvider(order.voucherProvider)) return true;
  const m = metaObj(order.metadata);
  return m.hubbleVoucher != null || m.hubbleStatus === 'SUCCESS';
}

/**
 * Validate + plan the voucher part of a MANUAL write against the order as READ. Throws 400 on a
 * rule violation; returns the columns to write and the CAS predicate the write must carry.
 */
export function planVoucherWrite(
  order: VoucherOrderState,
  input: VoucherWriteInput,
  opts: VoucherWriteOptions = {},
): VoucherWritePlan {
  const data: VoucherWritePlan['data'] = {};
  const none: VoucherWritePlan = { data, guard: null, issuesNewCode: false, overridden: false };
  const override = opts.manualOverride ?? null;
  if (override && !override.reason.trim()) throw new BadRequestException(OVERRIDE_REASON_MESSAGE);
  if (input.voucherCode === undefined && input.voucherProvider === undefined) {
    if (override) throw new BadRequestException(OVERRIDE_NEEDS_CODE_MESSAGE);
    return none;
  }

  if (input.voucherCode !== undefined && isBlank(input.voucherCode)) throw new BadRequestException(VOUCHER_BLANK_MESSAGE);
  if (input.voucherProvider !== undefined && isBlank(input.voucherProvider)) throw new BadRequestException(VOUCHER_BLANK_MESSAGE);

  const storedCode = norm(order.voucherCode);
  const storedProvider = norm(order.voucherProvider);
  const code = input.voucherCode === undefined ? undefined : norm(input.voucherCode)!;
  let provider = input.voucherProvider === undefined ? undefined : norm(input.voucherProvider)!;

  if (isHubbleProvider(provider) && provider !== storedProvider) throw new BadRequestException(HUBBLE_HAND_SET_MESSAGE);

  const codeChanges = code !== undefined && code !== storedCode;
  if (override) {
    if (!codeChanges) throw new BadRequestException(OVERRIDE_NEEDS_CODE_MESSAGE);
    if (!hasHubbleMarkers(order)) throw new BadRequestException(OVERRIDE_NOT_NEEDED_MESSAGE);
    // The manual provider replaces the Hubble stamp (markHubbleProcessing sets 'Hubble').
    if (provider === undefined || isHubbleProvider(provider)) provider = MANUAL_OVERRIDE_PROVIDER;
  }
  const providerChanges = provider !== undefined && provider !== storedProvider;
  if (!codeChanges && !providerChanges) return none; // idempotent re-send (trimmed compare)

  // Handed to Hubble: the integration owns it — only a reasoned GIFSY_ADMIN override may proceed.
  if (!override && hasHubbleMarkers(order)) throw new BadRequestException(HUBBLE_PROVIDER_MESSAGE);
  // Cash settles via the payout rail — never a voucher code.
  if (order.redemptionMode && CASH_PAYOUT_MODES.has(order.redemptionMode)) {
    throw new BadRequestException(VOUCHER_CASH_MESSAGE);
  }
  // Anything that changes the voucher on an order that already holds a code is a replace.
  if (storedCode !== null) throw new BadRequestException(VOUCHER_ALREADY_ISSUED_MESSAGE);
  if (codeChanges && opts.cancelledCodeReused) throw new BadRequestException(VOUCHER_REUSED_MESSAGE);
  if (!VOUCHER_WRITABLE_STATUSES.includes(order.status as RedemptionStatus) || !(order.pointsDeducted > 0)) {
    throw new BadRequestException(VOUCHER_STATUS_MESSAGE);
  }

  if (codeChanges) data.voucherCode = code;
  if (providerChanges) data.voucherProvider = provider;
  if (override) {
    // Ops took the order over from Hubble: clear the reconcile flag, record who/why/when.
    data.metadata = {
      ...metaObj(order.metadata),
      hubbleNeedsReconcile: false,
      hubbleStatus: 'MANUAL_OVERRIDE',
      hubbleManualOverride: {
        by: override.actorId,
        at: override.at.toISOString(),
        reason: override.reason.trim(),
        previousReason: metaObj(order.metadata).hubbleReconcileReason ?? null,
      },
    } as Prisma.InputJsonValue;
  }
  const and: Prisma.RedemptionOrderWhereInput[] = [
    { OR: [{ voucherCode: null }, { voucherCode: '' }] },
    { status: { in: [...VOUCHER_WRITABLE_STATUSES] } },
    { pointsDeducted: { gt: 0 } },
    // The provider read is part of the claim too (a concurrent Hubble stamp loses).
    order.voucherProvider == null
      ? { OR: [{ voucherProvider: null }, { voucherProvider: '' }] }
      : { voucherProvider: order.voucherProvider },
  ];
  // Optimistic lock on the row version as read: ANY write in between (a vendor-cancel, a refund,
  // a Hubble stamp) bumps @updatedAt → this write loses.
  if (order.updatedAt) and.push({ updatedAt: order.updatedAt });
  return { data, guard: { AND: and }, issuesNewCode: codeChanges, overridden: !!override };
}

/** Tenant-wide reuse lookup (only queried when a code is actually being written). */
export async function isCancelledVoucherCode(
  db: { cancelledVoucherCode: { findFirst: (a: Prisma.CancelledVoucherCodeFindFirstArgs) => Promise<unknown> } },
  clientId: string | null | undefined,
  code: string | null | undefined,
): Promise<boolean> {
  if (!clientId || typeof code !== 'string' || !code.trim()) return false;
  const hit = await db.cancelledVoucherCode.findFirst({
    where: { clientId, codeHash: hashVoucherCode(code) },
    select: { id: true },
  });
  return !!hit;
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
