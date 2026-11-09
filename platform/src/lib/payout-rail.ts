/**
 * Re-KYC payout RAIL rules — FE mirror of the backend's "never reject for something the rep can't
 * fix" rail-switch rules (api/src/kyc/kyc.service.ts create(), api/src/common/payout-rail.helper.ts).
 * MUST stay in sync with the backend definitions:
 *
 *   routing(upi)  = [upiId]
 *   routing(bank) = [accountNumber, ifscCode]
 *   editable(f)   = brand-new KYC  OR  blanket re-KYC (no field flags)  OR  f is flagged
 *   rail R REACHABLE ⇔ every routing field of R is editable OR already holds a non-empty stored
 *                      value (the existingKyc prefill)
 *   liveRail      = existingKyc.paymentMode (server-computed: 'upi' | 'bank' | null)
 *
 * The KYC wizard combines these with the rails the tenant / outlet mandate PERMITS
 * (allowedPaymentModes) via decidePayoutRail(). Pure functions — no React, no I/O.
 */
import { hasReKycFlags, isWizardFieldFlagged, type ReKycFlags } from './rekyc-fields';

export type PayoutRail = 'upi' | 'bank';
export type RoutingField = 'upiId' | 'accountNumber' | 'ifscCode';
/** Wizard payout fields (form keys + the cheque doc slot) — the keys isWizardFieldFlagged maps. */
export type PayoutField = 'bankName' | 'accountHolderName' | 'accountNumber' | 'ifscCode' | 'upiId' | 'cheque';

export const ROUTING_FIELDS: Record<PayoutRail, readonly RoutingField[]> = {
  upi: ['upiId'],
  bank: ['accountNumber', 'ifscCode'],
};

/** Stable rail order (matches allowedPaymentModes: bank first). */
const RAIL_ORDER: readonly PayoutRail[] = ['bank', 'upi'];

export interface PayoutRailContext {
  /** A brand-new KYC (no prior KYC on file → no existingKyc prefill): every field is editable. */
  isNewKyc: boolean;
  /** Outlet.reKycFlags (the admin's per-field request). No field booleans = blanket re-KYC. */
  flags: ReKycFlags;
  /** Stored routing values from the existingKyc prefill (null/absent on a brand-new KYC). */
  stored?: Partial<Record<RoutingField, string | null | undefined>> | null;
  /** existingKyc.paymentMode — the partner's current payout rail. */
  liveRail?: PayoutRail | null;
  /** Rails the tenant UPI gate + outlet mandate permit (allowedPaymentModes). */
  permittedRails: readonly PayoutRail[];
}

type EditCtx = Pick<PayoutRailContext, 'isNewKyc' | 'flags'>;

const filled = (v: string | null | undefined): boolean => typeof v === 'string' && v.trim() !== '';

/** editable(f) = brand-new KYC OR blanket re-KYC (no field flags) OR f is flagged. */
export function isPayoutFieldEditable(field: PayoutField, ctx: EditCtx): boolean {
  if (ctx.isNewKyc || !hasReKycFlags(ctx.flags)) return true;
  return isWizardFieldFlagged(ctx.flags, field);
}

/** Rail R is reachable ⇔ every routing field is editable or already holds a stored value. */
export function isRailReachable(rail: PayoutRail, ctx: PayoutRailContext): boolean {
  return ROUTING_FIELDS[rail].every((f) => isPayoutFieldEditable(f, ctx) || filled(ctx.stored?.[f]));
}

/** All reachable rails (bank first). */
export function reachableRails(ctx: PayoutRailContext): PayoutRail[] {
  return RAIL_ORDER.filter((r) => isRailReachable(r, ctx));
}

/** Allowed rails = reachable ∩ permitted (tenant UPI gate + outlet mandate), bank first. */
export function allowedRails(ctx: PayoutRailContext): PayoutRail[] {
  return RAIL_ORDER.filter((r) => ctx.permittedRails.includes(r) && isRailReachable(r, ctx));
}

/** True when a FIELD-FLAGGED re-KYC flagged at least one routing field of `rail`. */
export function railHasFlaggedRouting(rail: PayoutRail, ctx: EditCtx): boolean {
  if (ctx.isNewKyc || !hasReKycFlags(ctx.flags)) return false;
  return ROUTING_FIELDS[rail].some((f) => isWizardFieldFlagged(ctx.flags, f));
}

export interface PayoutRailDecision {
  /** Reachable ∩ permitted. */
  allowed: PayoutRail[];
  /** The rail the toggle is locked to, or null when the rep may choose (two allowed rails). */
  lockedRail: PayoutRail | null;
  /** True when the lock exists BECAUSE of the re-KYC (the tenant/outlet would permit both rails)
   *  → the wizard shows "Payment method can't be changed in this re-KYC". */
  lockedByReKyc: boolean;
  /** The rail the form opens on. */
  defaultRail: PayoutRail;
}

/**
 * The wizard's rail decision:
 *   • one allowed rail  → locked to it;
 *   • two allowed rails → free;
 *   • zero allowed      → locked to liveRail (when permitted), else bank (when permitted), else the
 *                         first permitted rail — locked payout fields then raise no validation errors.
 * Default: exactly one rail has a FLAGGED routing field AND it is allowed → that rail; else liveRail
 * if allowed; else the first allowed rail (a lock always wins).
 */
export function decidePayoutRail(ctx: PayoutRailContext): PayoutRailDecision {
  const allowed = allowedRails(ctx);
  const permitted = RAIL_ORDER.filter((r) => ctx.permittedRails.includes(r));
  const live = ctx.liveRail ?? null;

  let lockedRail: PayoutRail | null = null;
  if (allowed.length === 1) {
    lockedRail = allowed[0];
  } else if (allowed.length === 0) {
    lockedRail =
      live && permitted.includes(live) ? live : permitted.includes('bank') ? 'bank' : (permitted[0] ?? 'bank');
  }
  const lockedByReKyc = lockedRail !== null && permitted.length > 1;

  let defaultRail: PayoutRail;
  if (lockedRail) {
    defaultRail = lockedRail;
  } else {
    const flaggedRails = RAIL_ORDER.filter((r) => railHasFlaggedRouting(r, ctx));
    if (flaggedRails.length === 1 && allowed.includes(flaggedRails[0])) defaultRail = flaggedRails[0];
    else if (live && allowed.includes(live)) defaultRail = live;
    else defaultRail = allowed[0] ?? 'bank';
  }
  return { allowed, lockedRail, lockedByReKyc, defaultRail };
}

/* ── Reviewer detail pages: the rail a re-KYC approval REMOVES (backend getOne `removedRail`) ── */

/** Value-free notice text — identical to the approvals queue (kyc-approval-removed-rail). */
export const REMOVED_RAIL_NOTICE: Record<PayoutRail, string> = {
  upi: 'The partner’s current UPI ID will be removed on approval',
  bank: 'The partner’s current bank details will be removed on approval',
};

/** Partner payout columns (proposedPartner / ChannelPartner names) belonging to each rail. */
export const RAIL_PARTNER_KEYS: Record<PayoutRail, readonly string[]> = {
  upi: ['upiId'],
  bank: ['bankName', 'bankAccountNumber', 'bankAccountHolder', 'ifscCode'],
};

/** Narrow an unknown API value to a rail, else null. */
export function asPayoutRail(v: unknown): PayoutRail | null {
  return v === 'upi' || v === 'bank' ? v : null;
}

/**
 * Whether a per-field "Will be removed on approval" row for partner key `key` agrees with the
 * server's `removedRail`. When the response carries `removedRail` (hasRemovedRail) it is
 * authoritative: only that rail's columns may show as removed (null → none). When the field is
 * absent (an older backend) the per-field diff stands as before.
 */
export function isRemovalConsistent(key: string, hasRemovedRail: boolean, removedRail: PayoutRail | null): boolean {
  if (!hasRemovedRail) return true;
  return removedRail !== null && RAIL_PARTNER_KEYS[removedRail].includes(key);
}
