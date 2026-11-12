/**
 * VPA safeguards — EXCLUSIVE payout rails on a ChannelPartner.
 *
 * Payouts route UPI-first (rewards.service: `partnerSnap.upiId ? 'UPI' : 'BANK_TRANSFER'`), so a
 * partner carrying BOTH a UPI ID and bank details is always paid on the UPI — even when the rep chose
 * Bank. Every KYC path that SETS one rail must therefore clear the other. Only the partner's
 * payout-ROUTING columns are cleared — KYC document / cheque evidence (KycDocument rows, GCS objects,
 * and the redemption `payoutChequeFileKey`) are never touched by the KYC paths.
 *
 * NOTE: partner.service.capturePayoutDetails (redemption self-serve capture) keeps its OWN literal
 * write set (it also nulls payoutChequeFileKey on a UPI capture, as it always has) — it does NOT use
 * the constants below, so its behaviour is independent of the re-KYC apply.
 */

import { hasReKycFlags, type ReKycFlags } from './rekyc-fields';

export type PayoutRail = 'bank' | 'upi';

/** Upload/capture provenance of a UPI ID. NULL on the partner = legacy / unknown. */
export const UPI_CAPTURE_METHODS = ['QR', 'MANUAL'] as const;
export type UpiCaptureMethod = (typeof UPI_CAPTURE_METHODS)[number];

/** Narrow an unknown (e.g. a staged JSON value) to a valid capture method, else null. */
export function asUpiCaptureMethod(v: unknown): UpiCaptureMethod | null {
  return v === 'QR' || v === 'MANUAL' ? v : null;
}

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

/**
 * Columns nulled by a re-KYC APPROVAL that sets the UPI rail. Routing columns only — the redemption
 * cancelled-cheque key (payoutChequeFileKey) is EVIDENCE, not routing, and is deliberately kept.
 */
export const CLEAR_BANK_RAIL = {
  bankName: null,
  bankAccountHolder: null,
  bankAccountNumber: null,
  ifscCode: null,
} as const;

/** Columns nulled by a re-KYC APPROVAL that sets the bank rail. */
export const CLEAR_UPI_RAIL = {
  upiId: null,
  upiCaptureMethod: null,
} as const;

/** Payout values keyed by the KYC DTO field names (accountNumber, not bankAccountNumber). */
export interface PayoutRailValues {
  upiId?: unknown;
  accountNumber?: unknown;
  ifscCode?: unknown;
}

/**
 * THE definition of a COMPLETE payout rail (single source of truth for every rail decision):
 *   • UPI  → a non-empty upiId;
 *   • BANK → a non-empty account number AND a non-empty IFSC (either alone routes nothing).
 * Empty / whitespace-only strings count as absent.
 */
export function isCompletePayoutRail(rail: PayoutRail, v: PayoutRailValues): boolean {
  return rail === 'upi' ? filled(v.upiId) : filled(v.accountNumber) && filled(v.ifscCode);
}

/** True when a payload carries BOTH a complete UPI rail AND a complete bank rail. */
export function carriesBothPayoutRails(v: PayoutRailValues): boolean {
  return isCompletePayoutRail('upi', v) && isCompletePayoutRail('bank', v);
}

/**
 * The rail a payout-mode SETS given the values that will be persisted, or undefined when that rail
 * is not COMPLETE (isCompletePayoutRail). A mode whose rail is incomplete sets nothing — and
 * therefore clears nothing — so the exclusive-rail rule can never strip a partner of its only rail.
 */
export function payoutRailFor(mode: unknown, v: PayoutRailValues): PayoutRail | undefined {
  if (mode === 'upi' || mode === 'bank') return isCompletePayoutRail(mode, v) ? mode : undefined;
  return undefined;
}

/**
 * The rail a staged re-KYC proposal (KycSubmission.proposedPartner) SETS: ONLY the explicit
 * `payoutRail` key staged by create() when the rep set a routing field of the chosen rail
 * (resolveReKycPayout). Drafts staged before `payoutRail` existed (legacy) — and drafts that set no
 * routing field — carry no key → null → NOTHING is inferred and NOTHING is cleared.
 */
export function resolveProposedPayoutRail(proposed: Record<string, unknown>): PayoutRail | null {
  const explicit = proposed.payoutRail;
  return explicit === 'bank' || explicit === 'upi' ? explicit : null;
}

/**
 * The post-approval routing values (DTO keys) of a staged proposal (ChannelPartner field names):
 * a non-empty proposed value, else the live partner's value (an absent key = untouched at apply).
 */
function mergedRailValues(
  p: Record<string, unknown>,
  live?: Record<string, unknown> | null,
): PayoutRailValues {
  const pick = (k: string): unknown => (filled(p[k]) ? p[k] : live?.[k]);
  return { upiId: pick('upiId'), accountNumber: pick('bankAccountNumber'), ifscCode: pick('ifscCode') };
}

/**
 * Which capture method to record for a UPI ID being SET (R6/R7).
 *  • an explicit 'QR' → 'QR'; an explicit 'MANUAL' while manual entry is allowed → 'MANUAL';
 *  • otherwise (no method sent by an old cached FE, or a 'MANUAL' claim with manual entry OFF that
 *    passed the gate only because the value is UNCHANGED / INHERITED) → the matching PRIOR value's
 *    recorded method (the partner's stored UPI, or the group UPI the form was prefilled from);
 *  • no prior → null (unknown).
 * `prior` must be non-null only when the submitted UPI canonically equals that prior's upiId.
 */
export function resolveUpiCaptureMethod(
  sent: unknown,
  manualAllowed: boolean,
  prior: { upiCaptureMethod?: unknown } | null,
): UpiCaptureMethod | null {
  const m = asUpiCaptureMethod(sent);
  if (m === 'QR') return 'QR';
  if (m === 'MANUAL' && manualAllowed) return 'MANUAL';
  return prior ? asUpiCaptureMethod(prior.upiCaptureMethod) : null;
}

/** The re-KYC flag keys (Outlet.reKycFlags) that make a PAYOUT field editable. */
export const PAYOUT_REKYC_FLAG_KEYS = [
  'upiId',
  'accountNumber',
  'ifscCode',
  'bankName',
  'accountHolderName',
] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// RE-KYC PAYOUT RAIL RULES — "the server never rejects for something the rep cannot fix in the form".
// Pure functions shared (by mirroring) with the sales KYC form. All field names are the KYC DTO /
// re-KYC flag names (upiId, accountNumber, ifscCode, bankName, accountHolderName); stored values are
// passed in that same shape (ChannelPartner.bankAccountNumber → accountNumber).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A payout field, keyed by its KYC DTO / re-KYC flag name. */
export type PayoutField = (typeof PAYOUT_REKYC_FLAG_KEYS)[number];

/** The ROUTING fields of each rail — the ones a payout actually routes on. */
export const PAYOUT_ROUTING_FIELDS: Readonly<Record<PayoutRail, readonly PayoutField[]>> = {
  upi: ['upiId'],
  bank: ['accountNumber', 'ifscCode'],
};

/** Every payout field that BELONGS to each rail (routing + non-routing). */
export const PAYOUT_RAIL_FIELDS: Readonly<Record<PayoutRail, readonly PayoutField[]>> = {
  upi: ['upiId'],
  bank: ['bankName', 'accountHolderName', 'accountNumber', 'ifscCode'],
};

/** A predicate: may the rep edit this payout field in THIS submission? */
export type PayoutFieldEditable = (field: PayoutField) => boolean;

/**
 * editable(f) = brand-new KYC OR blanket re-KYC (no field flags) OR f is flagged.
 * `reKycFlags` is the outlet's Outlet.reKycFlags (ignored for a brand-new KYC).
 */
export function isPayoutFieldEditable(field: PayoutField, isNewKyc: boolean, reKycFlags: unknown): boolean {
  if (isNewKyc) return true;
  const flags = reKycFlags as ReKycFlags;
  if (!hasReKycFlags(flags)) return true;
  return (flags as Record<string, unknown>)[field] === true;
}

/** Curried form of isPayoutFieldEditable — the predicate the rail helpers below take. */
export function payoutFieldEditability(isNewKyc: boolean, reKycFlags: unknown): PayoutFieldEditable {
  return (f) => isPayoutFieldEditable(f, isNewKyc, reKycFlags);
}

/**
 * A rail R is REACHABLE ⇔ every routing field of R is editable OR already has a non-empty stored
 * value on the live partner. An unreachable rail can never be completed from the form.
 */
export function isPayoutRailReachable(
  rail: PayoutRail,
  editable: PayoutFieldEditable,
  stored: PayoutRailValues,
): boolean {
  const s = stored as Record<string, unknown>;
  return PAYOUT_ROUTING_FIELDS[rail].every((f) => editable(f) || filled(s[f]));
}

/**
 * The value a routing field will hold after this submission: the SUBMITTED value when the field is
 * editable, else the STORED value (a locked field is pinned to stored).
 */
function effectiveRoutingValue(
  f: PayoutField,
  editable: PayoutFieldEditable,
  submitted: Partial<Record<PayoutField, unknown>>,
  stored: PayoutRailValues,
): unknown {
  return editable(f) ? submitted[f] : (stored as Record<string, unknown>)[f];
}

/**
 * R is COMPLETE for a submission ⇔ every routing field has a non-empty value, taking the submitted
 * value for editable fields and the stored value for locked ones.
 */
export function isPayoutRailCompleteForSubmission(
  rail: PayoutRail,
  editable: PayoutFieldEditable,
  submitted: Partial<Record<PayoutField, unknown>>,
  stored: PayoutRailValues,
): boolean {
  return PAYOUT_ROUTING_FIELDS[rail].every((f) => filled(effectiveRoutingValue(f, editable, submitted, stored)));
}

/** The EDITABLE routing fields of `rail` the rep left empty (locked fields are never named). */
export function missingEditablePayoutRoutingFields(
  rail: PayoutRail,
  editable: PayoutFieldEditable,
  submitted: Partial<Record<PayoutField, unknown>>,
): PayoutField[] {
  return PAYOUT_ROUTING_FIELDS[rail].filter((f) => editable(f) && !filled(submitted[f]));
}

/** The 400 message for an incomplete-but-reachable rail — names ONLY the missing editable fields. */
export function incompletePayoutRailMessage(rail: PayoutRail, missing: readonly PayoutField[]): string {
  if (rail === 'upi') return 'Enter a UPI ID';
  const acct = missing.includes('accountNumber');
  const ifsc = missing.includes('ifscCode');
  if (acct && ifsc) return 'Enter both account number and IFSC';
  return acct ? 'Enter the account number' : 'Enter the IFSC';
}

/**
 * The partner's LIVE rail: 'upi' when a stored upiId is non-empty (payouts route UPI-first), else
 * 'bank' when a stored account number AND IFSC are non-empty, else null.
 */
export function livePayoutRail(stored: PayoutRailValues): PayoutRail | null {
  if (filled(stored.upiId)) return 'upi';
  if (filled(stored.accountNumber) && filled(stored.ifscCode)) return 'bank';
  return null;
}

export interface ReKycPayoutInput {
  /** body.paymentMode as sent (anything other than 'upi' | 'bank' counts as not sent). */
  requestedMode: unknown;
  /** The mode the outlet mandate + tenant UPI gate PIN (pinnedPaymentMode), or null when free. */
  mandateMode: PayoutRail | null;
  /** Is a rail permitted by the outlet mandate + tenant UPI gate (isPaymentModeAllowed)? */
  isRailAllowed: (rail: PayoutRail) => boolean;
  /** editable(f) — see payoutFieldEditability. */
  editable: PayoutFieldEditable;
  /** The submitted payout values (DTO names). */
  submitted: Partial<Record<PayoutField, unknown>>;
  /** The live partner's stored ROUTING values (DTO names; raw — never the display-hidden copy). */
  stored: PayoutRailValues;
}

export interface ReKycPayoutDecision {
  /** C — the rail this submission is evaluated against, or null (nothing payout-related staged). */
  rail: PayoutRail | null;
  /** The EDITABLE, non-empty fields of C to stage (DTO names). Never a locked value. */
  stageFields: PayoutField[];
  /** C when at least one ROUTING field of C is staged (→ stage payoutRail + paymentMode), else null. */
  payoutRail: PayoutRail | null;
  /** A 400 message (rule b — only ever names an EDITABLE field), else null. */
  error: string | null;
}

/**
 * Rule (a) — the rail C a re-KYC submission is evaluated against. A rail is USABLE when it is
 * permitted by the mandate / tenant UPI gate AND reachable. C = the requested rail
 * (body.paymentMode ?? mandate) when usable, else the partner's live rail when permitted, else null.
 * Never throws: an unusable request silently falls back (the rep could not have fixed it).
 */
export function resolveReKycPayoutRail(input: Omit<ReKycPayoutInput, 'submitted'>): PayoutRail | null {
  const { requestedMode, mandateMode, isRailAllowed, editable, stored } = input;
  const requested: PayoutRail | null =
    requestedMode === 'upi' || requestedMode === 'bank' ? requestedMode : mandateMode;
  if (requested && isRailAllowed(requested) && isPayoutRailReachable(requested, editable, stored)) {
    return requested;
  }
  const live = livePayoutRail(stored);
  // The live rail is always reachable (its routing values are stored); it must still be permitted
  // so a staged in-rail edit can never set a rail the mandate / tenant gate forbids.
  return live && isRailAllowed(live) ? live : null;
}

/**
 * SINGLE source of truth for a RE-KYC submission's payout staging (rules a–d):
 *  a. C = resolveReKycPayoutRail (no 400 for a missing / unreachable / forbidden request).
 *  b. C reachable but not complete → error naming only the missing EDITABLE routing field(s).
 *  c. Stage ONLY the editable, non-empty fields that belong to C — never a locked value; flagged
 *     fields of the other rail are ignored.
 *  d. payoutRail (and paymentMode) = C only when a routing field of C is staged — only then does
 *     approval clear the other rail.
 */
export function resolveReKycPayout(input: ReKycPayoutInput): ReKycPayoutDecision {
  const rail = resolveReKycPayoutRail(input);
  if (!rail) return { rail: null, stageFields: [], payoutRail: null, error: null };
  const { editable, submitted, stored } = input;
  if (!isPayoutRailCompleteForSubmission(rail, editable, submitted, stored)) {
    const missing = missingEditablePayoutRoutingFields(rail, editable, submitted);
    return { rail, stageFields: [], payoutRail: null, error: incompletePayoutRailMessage(rail, missing) };
  }
  const stageFields = PAYOUT_RAIL_FIELDS[rail].filter((f) => editable(f) && filled(submitted[f]));
  const setsRouting = stageFields.some((f) => PAYOUT_ROUTING_FIELDS[rail].includes(f));
  return { rail, stageFields, payoutRail: setsRouting ? rail : null, error: null };
}

/**
 * Staged payout keys (proposedPartner, ChannelPartner field names) → the re-KYC flag that made each
 * one editable. `paymentMode` / `upiCaptureMethod` have no flag of their own: they are editable when
 * ANY payout field is (see effectiveProposedPayout).
 */
const LEGACY_PAYOUT_KEY_FLAG: Record<string, (typeof PAYOUT_REKYC_FLAG_KEYS)[number] | 'any'> = {
  upiId: 'upiId',
  bankAccountNumber: 'accountNumber',
  ifscCode: 'ifscCode',
  bankName: 'bankName',
  bankAccountHolder: 'accountHolderName',
  upiCaptureMethod: 'any',
  paymentMode: 'any',
};

/**
 * Staged keys (ChannelPartner field names) dropped from a proposal whose explicit payoutRail is
 * INCOMPLETE at approval: that rail's ROUTING columns (+ the UPI capture provenance, meaningless
 * without a UPI ID). paymentMode is dropped alongside (see effectiveProposedPayout).
 */
const INCOMPLETE_RAIL_DROP_KEYS: Readonly<Record<PayoutRail, readonly string[]>> = {
  upi: ['upiId', 'upiCaptureMethod'],
  bank: ['bankAccountNumber', 'ifscCode'],
};

function omitKeys(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

/** PAYOUT_ROUTING_FIELDS (DTO names) → the ChannelPartner / proposedPartner key each one stages as. */
const ROUTING_FIELD_PARTNER_KEY: Readonly<Record<string, string>> = {
  upiId: 'upiId',
  accountNumber: 'bankAccountNumber',
  ifscCode: 'ifscCode',
};

/**
 * F1 — is EVERY routing field of `rail` present (non-empty) in the STAGED proposal itself
 * (KycSubmission.proposedPartner, ChannelPartner field names)? Only then were all the routing values
 * rep-entered and therefore visible to the reviewer as the proposal they approve. A rail completed from
 * a LOCKED live value (absent from the proposal) is applied, but its approval is NOT a verification of
 * the whole beneficiary — so it must never promote paymentDetailsStatus to VERIFIED.
 */
export function isPayoutRailFullyStaged(rail: PayoutRail, proposed: Record<string, unknown>): boolean {
  return PAYOUT_ROUTING_FIELDS[rail].every((f) => filled(proposed[ROUTING_FIELD_PARTNER_KEY[f]]));
}

/**
 * FIX 2 ("changed, not just vanished") — the proposedPartner key recording the routing values of the
 * staged rail that were NOT rep-entered but CARRIED from the live partner (a LOCKED field completing the
 * rail, e.g. account number staged + IFSC carried). INTERNAL bookkeeping only: never written to the
 * partner (the apply writes an explicit key list) and stripped from every reviewer/rep-facing surface
 * (effectiveProposedPayout / stripPayoutCarried) — it may hold a hidden, unverified live value.
 */
export const PAYOUT_CARRIED_KEY = 'payoutCarried';

/** Live payout routing columns (ChannelPartner names). */
export interface LivePayoutRouting {
  upiId?: string | null;
  bankAccountNumber?: string | null;
  ifscCode?: string | null;
}

/**
 * The routing values (ChannelPartner keys) of `rail` that the staged `proposal` does NOT carry itself
 * and that therefore complete the rail from the LIVE partner at approval. Undefined when nothing is
 * carried (every routing field staged, or the stored value is empty).
 */
export function carriedPayoutRouting(
  rail: PayoutRail,
  proposal: Record<string, unknown>,
  stored: LivePayoutRouting | null | undefined,
): Record<string, string> | undefined {
  const carried: Record<string, string> = {};
  for (const f of PAYOUT_ROUTING_FIELDS[rail]) {
    const key = ROUTING_FIELD_PARTNER_KEY[f];
    if (filled(proposal[key])) continue;
    const v = (stored as Record<string, unknown> | null | undefined)?.[key];
    if (typeof v === 'string' && filled(v)) carried[key] = v;
  }
  return Object.keys(carried).length > 0 ? carried : undefined;
}

/** Canonical compare form of a carried routing value (UPI lower, IFSC upper, account trimmed). */
function canonicalRouting(key: string, v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  if (key === 'upiId') return t.toLowerCase(); // == normalizeIdentityValue('upi')
  if (key === 'ifscCode') return t.toUpperCase();
  return t; // bankAccountNumber == normalizeIdentityValue('bank')
}

/**
 * True when ANY routing value recorded as carried at draft time (proposal.payoutCarried) differs from
 * the live (row-locked) partner's current value — the outlet's payout details CHANGED after the KYC
 * was submitted, so the rail the reviewer approved can no longer be applied as seen. A legacy draft
 * without the key → false (behaves as before).
 */
export function payoutCarriedChanged(proposal: Record<string, unknown>, live: LivePayoutRouting): boolean {
  const carried = proposal[PAYOUT_CARRIED_KEY];
  if (!carried || typeof carried !== 'object' || Array.isArray(carried)) return false;
  return Object.entries(carried as Record<string, unknown>).some(
    ([key, v]) => canonicalRouting(key, v) !== canonicalRouting(key, (live as Record<string, unknown>)[key]),
  );
}

/** The proposal WITHOUT the internal payoutCarried bookkeeping (for every outward-facing surface). */
export function stripPayoutCarried<T>(proposal: T): T {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
  if (!(PAYOUT_CARRIED_KEY in (proposal as Record<string, unknown>))) return proposal;
  const { [PAYOUT_CARRIED_KEY]: _omit, ...rest } = proposal as Record<string, unknown>;
  void _omit;
  return rest as T;
}

export interface EffectiveProposedPayout {
  /** The proposal to apply/present — payout keys the rep could not edit (legacy drafts) removed. */
  proposal: Record<string, unknown>;
  /** The rail this proposal SETS (explicit payoutRail only), else null. */
  rail: PayoutRail | null;
  /** The OTHER rail's routing columns, nulled at approval (empty when rail is null). */
  clears: Record<string, null>;
}

/**
 * SINGLE source of truth for what a re-KYC approval does to the partner's payout columns — used by
 * the apply (applyBridgeOutcome), the reviewer queue/export overlay AND the detail view (getOne), so
 * what the reviewer sees is exactly what approval writes.
 *
 *  • NEW drafts with an explicit `payoutRail` (create() staged it because the rep SET at least one
 *    routing field of that rail — resolveReKycPayout rule d) that is COMPLETE once merged over the
 *    live partner: apply the staged rail's values and clear the other rail.
 *  • An explicit `payoutRail` that is INCOMPLETE once merged (a locked routing value vanished before
 *    approval): rail null, nothing cleared, AND that rail's routing keys + paymentMode are dropped
 *    from the proposal (never a half rail / a paymentMode contradicting the routed rail).
 *  • Drafts WITHOUT `payoutRail`: never infer a rail, never clear. A new draft that set no routing
 *    field (payout fields locked, or only bankName / accountHolderName edited) stages only those
 *    editable fields (each kept by the flag filter below, no paymentMode). A LEGACY draft (staged before this
 *    change, which echoed LOCKED payout values back) is filtered against the outlet's re-KYC flags —
 *    `Outlet.reKycFlags`, the admin's per-field request that create() enforced its text lock from and
 *    that stays set on the outlet until this approval clears it: a staged payout key is kept only when
 *    its own flag is true (paymentMode / upiCaptureMethod when ANY payout flag is true). When the
 *    flags carry no field booleans (blanket / first-time re-KYC → every field was editable, or flags
 *    unavailable) editability cannot be narrowed → the staged keys pass through unchanged (the
 *    pre-change write-back behaviour).
 */
export function effectiveProposedPayout(
  stagedProposal: Record<string, unknown>,
  outletReKycFlags: unknown,
  livePartner?: Record<string, unknown> | null,
): EffectiveProposedPayout {
  // FIX 2: the internal `payoutCarried` bookkeeping never reaches a presented/applied proposal.
  const proposed = stripPayoutCarried(stagedProposal);
  // An explicit rail counts only when the rail is COMPLETE after approval (isCompletePayoutRail) —
  // an incomplete one sets nothing and therefore clears nothing. A re-KYC stages ONLY the editable
  // fields, so a LOCKED routing field (e.g. the stored IFSC when only the account number was
  // flagged) is absent from the proposal and stays untouched at apply → completeness merges the
  // proposal OVER the RAW live partner (ChannelPartner field names). Callers MUST pass the raw
  // (never display-hidden) partner; without it only the proposal counts (fail-safe: clears less).
  const explicitRail = resolveProposedPayoutRail(proposed);
  const rail =
    explicitRail && isCompletePayoutRail(explicitRail, mergedRailValues(proposed, livePartner))
      ? explicitRail
      : null;
  if (rail) {
    return { proposal: proposed, rail, clears: rail === 'upi' ? { ...CLEAR_BANK_RAIL } : { ...CLEAR_UPI_RAIL } };
  }
  // INCOMPLETE explicit rail (M3): the staged chosen rail is NOT complete once merged over the live
  // partner (e.g. the locked stored IFSC disappeared between draft and approval). Approval must then
  // write NONE of that rail's routing columns and NO paymentMode — otherwise it would leave a half
  // bank rail and a paymentMode contradicting the rail payouts actually route on. Non-routing fields
  // (bankName / bankAccountHolder) route nothing and still apply. Done HERE so getOne and the reviewer
  // queue/export never present a half rail. NOTE (F2): the APPROVAL apply (kyc.service
  // applyBridgeOutcome) re-evaluates this over the ROW-LOCKED partner and REFUSES (409) a proposal whose
  // explicit rail is incomplete — it never silently applies this dropped form.
  const base: Record<string, unknown> = explicitRail
    ? omitKeys(proposed, [...INCOMPLETE_RAIL_DROP_KEYS[explicitRail], 'paymentMode'])
    : proposed;
  const flags = outletReKycFlags as ReKycFlags;
  if (!hasReKycFlags(flags)) return { proposal: base, rail: null, clears: {} };
  const f = flags as Record<string, unknown>;
  const anyPayoutFlag = PAYOUT_REKYC_FLAG_KEYS.some((k) => f[k] === true);
  const proposal: Record<string, unknown> = { ...base };
  for (const [key, flag] of Object.entries(LEGACY_PAYOUT_KEY_FLAG)) {
    if (!(key in proposal)) continue;
    const editable = flag === 'any' ? anyPayoutFlag : f[flag] === true;
    if (!editable) delete proposal[key];
  }
  return { proposal, rail: null, clears: {} };
}
