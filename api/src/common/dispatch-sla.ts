/**
 * Channel-aware dispatch SLA (Gift Catalogue & Dispatch, §5 / §12).
 *
 * A confirmed physical/warehouse gift order should be DISPATCHED within N business
 * hours. We reuse the shared business-hours clock (Mon–Fri, IST, minus holidays)
 * so the SLA never false-breaches over a weekend.
 *
 * CHANNEL-AWARE (§12): only self-fulfilled channels have an "undispatched" SLA —
 *   • GIFSY_WAREHOUSE / BRAND → SLA applies.
 *   • FULFILLED_BY_AMAZON     → Amazon owns dispatch; no platform SLA.
 *   • DIGITAL_VOUCHER         → instant; no dispatch step.
 * A null `fulfilmentChannel` (not yet routed) is treated as SLA-applicable so a
 * stuck, unrouted order still surfaces to ops.
 *
 * Pure + DI-free so it unit-tests without booting Nest. The caller supplies the
 * holiday set (from tenant settings) and the SLA hours.
 */

import { businessHoursBetween } from './business-hours';

/** Fulfilment channels that carry a platform dispatch SLA. */
export type SlaChannel = string | null | undefined;

export interface DispatchSlaInput {
  fulfilmentChannel: SlaChannel;
  status: string;
  /** When the SLA clock STARTS (order confirmed) — ms epoch, or null if unknown. */
  confirmedAtMs: number | null;
  /** When the order was dispatched — ms epoch, or null if not yet dispatched. */
  dispatchedAtMs: number | null;
  /** "now" for aging an undispatched order — ms epoch. */
  nowMs: number;
  /** SLA budget in BUSINESS hours (e.g. 48). */
  slaBusinessHours: number;
  /** Holiday set (YYYY-MM-DD) for the business-hours clock. */
  holidays?: Set<string>;
}

export interface DispatchSlaResult {
  /** Does this channel/state carry a dispatch SLA at all? */
  applicable: boolean;
  /** Business hours elapsed in the "awaiting dispatch" window (0 when N/A). */
  elapsedBusinessHours: number;
  /** True once elapsed exceeds the budget while still undispatched. */
  breached: boolean;
}

const CHANNELS_WITH_SLA = new Set(['GIFSY_WAREHOUSE', 'BRAND']);
const NO_SLA_CHANNELS = new Set(['FULFILLED_BY_AMAZON', 'DIGITAL_VOUCHER']);

/** Statuses where an order is still "awaiting dispatch" (the SLA is live). */
const PRE_DISPATCH_STATUSES = new Set(['CONFIRMED', 'PROCESSING']);

/**
 * Is the SLA applicable to this order right now? Channel drives it; a null channel
 * (unrouted) counts as applicable so a stuck order isn't silently exempt.
 */
export function dispatchSlaApplies(channel: SlaChannel): boolean {
  if (channel == null) return true;
  if (NO_SLA_CHANNELS.has(channel)) return false;
  return CHANNELS_WITH_SLA.has(channel) || false;
}

/**
 * Compute the dispatch-SLA aging/breach for one order. Only meaningful while the
 * order is pre-dispatch; once DISPATCHED/DELIVERED/terminal it is not breaching.
 */
export function computeDispatchSla(input: DispatchSlaInput): DispatchSlaResult {
  const {
    fulfilmentChannel,
    status,
    confirmedAtMs,
    dispatchedAtMs,
    nowMs,
    slaBusinessHours,
    holidays = new Set<string>(),
  } = input;

  if (!dispatchSlaApplies(fulfilmentChannel)) {
    return { applicable: false, elapsedBusinessHours: 0, breached: false };
  }
  // No start point → can't age it.
  if (confirmedAtMs == null) {
    return { applicable: true, elapsedBusinessHours: 0, breached: false };
  }

  // If already dispatched, the window closed at dispatch — report elapsed but never
  // "breached" (it's done). If still pre-dispatch, age against now.
  const isPreDispatch = PRE_DISPATCH_STATUSES.has(status);
  const endMs = dispatchedAtMs ?? (isPreDispatch ? nowMs : confirmedAtMs);
  const elapsed = businessHoursBetween(confirmedAtMs, endMs, holidays);
  const breached = isPreDispatch && dispatchedAtMs == null && elapsed > slaBusinessHours;

  return { applicable: true, elapsedBusinessHours: elapsed, breached };
}
