import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PayoutMode, Prisma, RedemptionStatus } from '@prisma/client';
import { noIssuedVoucherGuard } from './order-status-transition';

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
 *    cancelled_voucher_codes) → 400 — checked by the caller INSIDE its write transaction under a
 *    (tenant, code) advisory lock (assertVoucherCodeReusableInTx), so a concurrent cancel can't race;
 *  - a NEW code only on a paid, open order: CONFIRMED / PROCESSING / DISPATCHED with
 *    pointsDeducted > 0 — and the write is a compare-and-set on exactly that, the provider read
 *    and the row's updatedAt, so ANY concurrent write (refund, vendor-cancel, other edit) makes it
 *    lose (0 rows → 409).
 *
 * VOUCHER PIN (card+PIN gift cards — optional, written only together with its code):
 *  - omitted / blank            → no PIN (the field is optional; blank is never a "clear");
 *  - a PIN with no code supplied and none stored → 400 "Enter the card number before the PIN";
 *  - SET-ONCE: a code is stored and NO PIN yet → the PIN may be added (with or without re-sending
 *    the same code), on a CONFIRMED / PROCESSING / DISPATCHED / DELIVERED paid order — a
 *    compare-and-set on { the stored code, voucherPin still null, row version } so two writers
 *    can't both set it (the loser gets 409). The caller audits it (masked) and re-sends the
 *    member's voucher notification so the owner receives the PIN;
 *  - a PIN that differs from an already-stored PIN → 400 (VOUCHER_PIN_ALREADY_SAVED_MESSAGE — only
 *    "Voucher cancelled with vendor" clears/replaces it);
 *  - identical to the stored PIN → no-op. The PIN is NEVER uniqueness/reuse-checked;
 *  - longer than VOUCHER_PIN_MAX_LENGTH → 400 (enforced HERE too, so the bulk sheet path — which
 *    never passes through the DTO — is covered).
 *
 * VOUCHER PROVIDER on an order that already holds a code:
 *  - stored provider NULL / blank → it may be SET ONCE (with or without a PIN add), on the same
 *    statuses as a PIN add, as a compare-and-set that includes `voucherProvider: null` (as read) so
 *    two writers can't both set it. No audit / notification for a provider-only set (a label);
 *  - stored provider non-null and different → 400 (VOUCHER_ALREADY_ISSUED_MESSAGE — a replace).
 *
 * LOST PIN RACE (double submit): when a PIN-add compare-and-set loses (409), the caller re-reads the
 * row and, if the stored code is unchanged and the stored PIN now EQUALS the requested PIN, treats it
 * as a successful no-op (pinRaceIsIdempotent) — no second audit row or notification.
 *
 * CHANNEL: deliberately NOT restricted — a physical gift card carrying a card number / PIN is
 * legitimate on any fulfilment channel, so a stored code never blocks a channel change.
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
export const VOUCHER_PIN_NEEDS_CODE_MESSAGE = 'Enter the card number before the PIN';
export const VOUCHER_PIN_ALREADY_SAVED_MESSAGE =
  "A PIN is already saved for this voucher; use 'Voucher cancelled with vendor' to replace it.";
export const VOUCHER_PROVIDER_STATUS_MESSAGE =
  'A provider can only be added to a paid order that is confirmed, processing, dispatched or delivered.';
export const VOUCHER_PIN_STATUS_MESSAGE =
  'A PIN can only be added to a paid order that is confirmed, processing, dispatched or delivered.';
/** Same cap as the DTOs' @MaxLength(64) on voucherPin. */
export const VOUCHER_PIN_MAX_LENGTH = 64;
export const VOUCHER_PIN_TOO_LONG_MESSAGE = `The voucher PIN must be at most ${VOUCHER_PIN_MAX_LENGTH} characters.`;

/** Statuses on which a PIN may be ADDED to an already-stored code (set-once). */
export const VOUCHER_PIN_ADDABLE_STATUSES: readonly RedemptionStatus[] = [
  ...VOUCHER_WRITABLE_STATUSES,
  RedemptionStatus.DELIVERED,
];

/** Default provider label for a manual override that names none. */
export const MANUAL_OVERRIDE_PROVIDER = 'Manual';

export interface VoucherWriteInput {
  voucherCode?: string | null;
  voucherProvider?: string | null;
  /** Optional card PIN (card+PIN products). Blank = no PIN. */
  voucherPin?: string | null;
}

export interface VoucherOrderState {
  status: RedemptionStatus | string;
  voucherCode: string | null;
  voucherProvider: string | null;
  /** Stored PIN (optional: legacy readers / fixtures omit it → treated as none). */
  voucherPin?: string | null;
  pointsDeducted: number;
  redemptionMode?: PayoutMode | string | null;
  metadata?: Prisma.JsonValue | null;
  updatedAt?: Date | null;
}

export interface VoucherWriteOptions {
  /** A GIFSY_ADMIN's explicit, reasoned manual fulfilment of a Hubble-handed order. */
  manualOverride?: { reason: string; actorId: string; at: Date } | null;
}

export interface VoucherWritePlan {
  /** Only the columns that actually change. Spread into the write's `data`. */
  data: { voucherCode?: string; voucherPin?: string; voucherProvider?: string; metadata?: Prisma.InputJsonValue };
  /** Claim predicate to AND into the write's `where` (null = no voucher write → no extra guard). */
  guard: Prisma.RedemptionOrderWhereInput | null;
  /** True when this write sets a NEW code (caller audits + notifies the member). */
  issuesNewCode: boolean;
  /**
   * True when this write ADDS a PIN to an already-stored code (set-once). The caller audits it
   * (masked) and re-sends the member's voucher notification so the owner gets the PIN.
   */
  addsPin: boolean;
  /** True when this write sets a provider on a stored code whose provider was empty (set-once). */
  setsProvider?: boolean;
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
  // An OPEN reconcile flag always counts — even after a manual override / release: a later flag
  // (e.g. HUBBLE_SUCCESS_MANUAL_CODE_PRESENT — Hubble issued on top of the manual code) must keep
  // the order refund-blocked and visible to ops.
  if (m.hubbleNeedsReconcile === true) return true;
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
 * Reconcile reasons that PROVE no Hubble order was ever placed — both are set by
 * issueHubbleVoucherForOrder BEFORE placeOrder is called:
 *  - HUBBLE_NOT_CONFIGURED: the tenant flag is on but the Hubble client isn't provisioned;
 *  - HUBBLE_INVALID_AMOUNT: no issuable whole-rupee value, so nothing was sent to Hubble.
 * Deliberately EXCLUDED (Hubble may hold / have issued a voucher): HUBBLE_INDETERMINATE,
 * HUBBLE_PROCESSING_NOT_FOUND, HUBBLE_SUCCESS_NO_CODE, HUBBLE_UNKNOWN_STATUS:*,
 * HUBBLE_SUCCESS_MANUAL_CODE_PRESENT, and HUBBLE_UNEXPECTED (the catch-all can fire AFTER a
 * successful placement, e.g. a DB error while storing the voucher). HUBBLE_FAILED_VOUCHER_PRESENT
 * is resolved separately: cancelling its manual code releases the flag (voucherCancelledWithVendor).
 * HUBBLE_INDETERMINATE (and HUBBLE_UNEXPECTED only with a recorded place attempt that never got a
 * response — metadata.hubblePlaceAttemptAt + hubblePlaceResponded:false) have a separate, automatic
 * exit instead: an ops "Retry with Hubble" that gets Hubble's own not-found after the safety margin
 * fails + refunds the order (RewardsService.resolveNoHubbleOrder / HUBBLE_NO_ORDER_REFUNDABLE_REASONS).
 * They stay OUT of this set: this set allows a MANUAL refund with no Hubble lookup at all.
 */
export const HUBBLE_NEVER_PLACED_REASONS: ReadonlySet<string> = new Set([
  'HUBBLE_NOT_CONFIGURED',
  'HUBBLE_INVALID_AMOUNT',
]);

/**
 * The order's ONLY Hubble trace is a reconcile reason proving nothing was ever placed with Hubble
 * (no Hubble provider / status / order id / voucher), and no code is stored — so Hubble never held
 * a voucher for it and a manual refund is safe.
 */
export function isHubbleNeverPlaced(order: {
  voucherCode?: string | null;
  voucherProvider?: string | null;
  metadata?: Prisma.JsonValue | null;
}): boolean {
  if (norm(order.voucherCode) !== null) return false;
  if (isHubbleProvider(order.voucherProvider)) return false;
  const m = metaObj(order.metadata);
  if (m.hubbleStatus != null || m.hubbleOrderId != null || m.hubbleVoucher != null) return false;
  return typeof m.hubbleReconcileReason === 'string' && HUBBLE_NEVER_PLACED_REASONS.has(m.hubbleReconcileReason);
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
  const none: VoucherWritePlan = { data, guard: null, issuesNewCode: false, addsPin: false, overridden: false };
  const override = opts.manualOverride ?? null;
  if (override && !override.reason.trim()) throw new BadRequestException(OVERRIDE_REASON_MESSAGE);
  // Blank PIN = not supplied (optional field — never a "clear").
  const pin = norm(input.voucherPin ?? undefined) ?? undefined;
  if (pin !== undefined && pin.length > VOUCHER_PIN_MAX_LENGTH) throw new BadRequestException(VOUCHER_PIN_TOO_LONG_MESSAGE);
  if (input.voucherCode === undefined && input.voucherProvider === undefined && pin === undefined) {
    if (override) throw new BadRequestException(OVERRIDE_NEEDS_CODE_MESSAGE);
    return none;
  }

  if (input.voucherCode !== undefined && isBlank(input.voucherCode)) throw new BadRequestException(VOUCHER_BLANK_MESSAGE);
  if (input.voucherProvider !== undefined && isBlank(input.voucherProvider)) throw new BadRequestException(VOUCHER_BLANK_MESSAGE);

  const storedCode = norm(order.voucherCode);
  const storedProvider = norm(order.voucherProvider);
  const storedPin = norm(order.voucherPin);
  // A PIN needs its card number: supplied on this write, or already on the order.
  if (pin !== undefined && (input.voucherCode === undefined || isBlank(input.voucherCode)) && storedCode === null) {
    throw new BadRequestException(VOUCHER_PIN_NEEDS_CODE_MESSAGE);
  }
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
  const pinChanges = pin !== undefined && pin !== storedPin;
  if (!codeChanges && !providerChanges && !pinChanges) return none; // idempotent re-send (trimmed compare)

  // Handed to Hubble: the integration owns it — only a reasoned GIFSY_ADMIN override may proceed.
  if (!override && hasHubbleMarkers(order)) throw new BadRequestException(HUBBLE_PROVIDER_MESSAGE);
  // Cash settles via the payout rail — never a voucher code.
  if (order.redemptionMode && CASH_PAYOUT_MODES.has(order.redemptionMode)) {
    throw new BadRequestException(VOUCHER_CASH_MESSAGE);
  }
  // A code change on an order that already holds a code is a replace; so is changing a provider
  // that is already set. (Setting a provider where none is stored is a set-once fill — below.)
  if (storedCode !== null && (codeChanges || (providerChanges && storedProvider !== null))) {
    throw new BadRequestException(VOUCHER_ALREADY_ISSUED_MESSAGE);
  }
  if (storedCode !== null) {
    // Only the PIN and/or an empty provider change here. SET-ONCE: a stored PIN is never replaced.
    if (pinChanges && storedPin !== null) throw new BadRequestException(VOUCHER_PIN_ALREADY_SAVED_MESSAGE);
    if (!VOUCHER_PIN_ADDABLE_STATUSES.includes(order.status as RedemptionStatus) || !(order.pointsDeducted > 0)) {
      throw new BadRequestException(pinChanges ? VOUCHER_PIN_STATUS_MESSAGE : VOUCHER_PROVIDER_STATUS_MESSAGE);
    }
    const fillAnd: Prisma.RedemptionOrderWhereInput[] = [
      // The code exactly as read (a concurrent "Voucher cancelled with vendor" clears it → loses).
      { voucherCode: order.voucherCode },
    ];
    if (pinChanges) {
      data.voucherPin = pin;
      // Set-once: the PIN is still empty as read (a legacy whitespace-only value pinned verbatim).
      fillAnd.push(order.voucherPin == null ? { voucherPin: null } : { voucherPin: order.voucherPin });
    }
    if (providerChanges) {
      data.voucherProvider = provider;
      // Set-once: the provider is still empty exactly as read (a concurrent set loses).
      fillAnd.push(order.voucherProvider == null ? { voucherProvider: null } : { voucherProvider: order.voucherProvider });
    }
    fillAnd.push({ status: { in: [...VOUCHER_PIN_ADDABLE_STATUSES] } }, { pointsDeducted: { gt: 0 } });
    if (order.updatedAt) fillAnd.push({ updatedAt: order.updatedAt });
    return {
      data,
      guard: { AND: fillAnd },
      issuesNewCode: false,
      addsPin: pinChanges,
      setsProvider: providerChanges,
      overridden: false,
    };
  }
  // (Tenant-wide cancelled-code reuse is checked INSIDE the write tx: assertVoucherCodeReusableInTx.)
  if (!VOUCHER_WRITABLE_STATUSES.includes(order.status as RedemptionStatus) || !(order.pointsDeducted > 0)) {
    throw new BadRequestException(VOUCHER_STATUS_MESSAGE);
  }

  if (codeChanges) data.voucherCode = code;
  // Reaching here means no code is stored, so a PIN can only land together with a NEW code.
  if (pinChanges) data.voucherPin = pin;
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
    // "No code" exactly as read (a legacy whitespace-only value is pinned verbatim — no 409 loop).
    noIssuedVoucherGuard(order.voucherCode),
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
  return { data, guard: { AND: and }, issuesNewCode: codeChanges, addsPin: false, overridden: !!override };
}

/**
 * True when planVoucherWrite would ACCEPT a set-once fill (a PIN and/or an empty provider) on this
 * order's STORED code: a code is stored, the order is not handed to Hubble, not cash, on a
 * PIN-addable status and paid. Exposed to the fulfilment UIs (as `voucherFillable`) so they only
 * offer the "Add the PIN…" box when the server would take it — one rule, no FE mirror to drift.
 * (Whether a PIN / provider is ALREADY stored is checked by the caller per field.)
 */
export function canFillStoredVoucher(order: {
  status: RedemptionStatus | string;
  voucherCode: string | null;
  voucherProvider?: string | null;
  pointsDeducted?: number | null;
  redemptionMode?: PayoutMode | string | null;
  metadata?: Prisma.JsonValue | null;
}): boolean {
  if (norm(order.voucherCode) === null) return false;
  if (hasHubbleMarkers(order)) return false;
  if (order.redemptionMode && CASH_PAYOUT_MODES.has(order.redemptionMode)) return false;
  if (!VOUCHER_PIN_ADDABLE_STATUSES.includes(order.status as RedemptionStatus)) return false;
  return (order.pointsDeducted ?? 0) > 0;
}

/**
 * LOST PIN RACE (double submit of the same PIN): the PIN-add compare-and-set matched 0 rows. Given
 * the row RE-READ after the loss, true when the code is still the one read and the stored PIN now
 * equals the requested PIN — the other writer saved exactly what this one wanted, so the caller
 * treats it as a successful no-op (retrying once: the PIN is then idempotent — no audit, no
 * notification). Anything else (a different PIN, a cleared/changed code, the row gone) stays a 409.
 */
export function pinRaceIsIdempotent(
  plan: Pick<VoucherWritePlan, 'addsPin'>,
  read: { voucherCode: string | null },
  input: VoucherWriteInput,
  current: { voucherCode: string | null; voucherPin?: string | null } | null | undefined,
): boolean {
  if (!plan.addsPin || !current) return false;
  const wanted = norm(input.voucherPin ?? undefined);
  const code = norm(current.voucherCode);
  if (wanted === null || code === null) return false;
  if (input.voucherCode !== undefined && norm(input.voucherCode) !== code) return false;
  return code === norm(read.voucherCode) && norm(current.voucherPin) === wanted;
}

/**
 * Thrown by a write path whose PIN-add lost to an identical concurrent PIN add (pinRaceIsIdempotent).
 * withPinRaceRetry catches it and runs the write ONCE more — the PIN is then an idempotent no-op
 * (no audit, no notification). It IS a 409, so if it ever escapes (a second identical race) the
 * caller still sees the normal conflict.
 */
export class PinRaceResolvedError extends ConflictException {
  constructor() {
    super(VOUCHER_WRITE_CONFLICT_MESSAGE);
  }
}

/**
 * In a write path's catch: a ConflictException on a PIN-add plan → re-read the row; when the
 * identical PIN is now stored on the same code, throw PinRaceResolvedError (→ retried as a no-op).
 * Otherwise rethrow the original error unchanged.
 */
export async function rethrowUnlessIdempotentPinRace(
  e: unknown,
  plan: Pick<VoucherWritePlan, 'addsPin'>,
  read: { voucherCode: string | null },
  input: VoucherWriteInput,
  reread: () => Promise<{ voucherCode: string | null; voucherPin?: string | null } | null>,
): Promise<never> {
  if (e instanceof ConflictException && !(e instanceof PinRaceResolvedError) && plan.addsPin) {
    const current = await Promise.resolve()
      .then(reread)
      .catch(() => null);
    if (pinRaceIsIdempotent(plan, read, input, current)) throw new PinRaceResolvedError();
  }
  throw e;
}

/** Run a manual voucher write; on PinRaceResolvedError run it exactly once more. */
export async function withPinRaceRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof PinRaceResolvedError) return run();
    throw e;
  }
}

/**
 * Serialise every write of a given code in a tenant (issue vs "Voucher cancelled with vendor"):
 * a transaction-scoped advisory lock on (tenant, code hash). Call it FIRST inside the write tx,
 * in BOTH the cancel tx and every new-code tx, so a cancel that commits concurrently is always
 * seen by the reuse check that follows (READ COMMITTED re-reads after the lock is granted).
 */
export async function lockVoucherCode(
  tx: { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> },
  clientId: string,
  code: string,
): Promise<void> {
  const key = `voucher:${clientId}:${hashVoucherCode(code)}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * INSIDE the write transaction: lock the (tenant, code) key, then refuse a code cancelled with the
 * vendor anywhere in the tenant. Closes the check-then-write race with a concurrent cancel.
 */
export async function assertVoucherCodeReusableInTx(
  tx: {
    $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
    cancelledVoucherCode: { findFirst: (a: Prisma.CancelledVoucherCodeFindFirstArgs) => Promise<unknown> };
  },
  clientId: string,
  code: string,
): Promise<void> {
  await lockVoucherCode(tx, clientId, code);
  if (await isCancelledVoucherCode(tx, clientId, code)) throw new BadRequestException(VOUCHER_REUSED_MESSAGE);
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
