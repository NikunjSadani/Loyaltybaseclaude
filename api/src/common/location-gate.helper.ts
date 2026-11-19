/**
 * Location gate ("no location, no use") — owner-approved 2026-11-18. Design: platform/docs/plans/LOCATION-GATE.md.
 *
 * Per-tenant BEHAVIOUR flag `clients.features.requireLocation` (default OFF → every tenant incl. live Deoleo is
 * byte-identical). When ON, a SALES rep's KYC submission and visibility capture are REFUSED server-side unless they
 * carry a valid GPS fix — so an old app build / page cannot bypass the phone-side gate. Non-sales initiators
 * (partner self-enrollment, admins on a desktop) are never gated.
 *
 * Also: when the flag is ON, every "outside the 200 m fence" refusal is RECORDED (one AuditLog row) so the
 * location-compliance report can count blocked attempts. Nothing is recorded for a tenant with the flag OFF.
 */
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { isUsableReference } from '../visibility/geo-fence.helper';

/** The `clients.features` key. */
export const LOCATION_REQUIRED_FEATURE = 'requireLocation';

/** AuditLog.entityType for a recorded "outside the fence" refusal (action REJECT, entityId = outlet id). */
export const FENCE_BLOCK_ENTITY = 'LOCATION_FENCE_BLOCK';

/** A fix worse than this (metres) counts as "poor accuracy" in the report + digest (= the FE early-accept target). */
export const POOR_ACCURACY_M = 50;

export const LOCATION_REQUIRED_KYC_MESSAGE =
  'Location is required to submit a KYC for this programme. Turn on location for this site and on the phone, retake the store board photo so its location is captured, then submit again.';

export const LOCATION_REQUIRED_VISIBILITY_MESSAGE =
  'Location is required to submit a visibility capture for this programme. Turn on location for this site and on the phone, retake the photos so their location is captured, then submit again.';

/**
 * A real GPS fix: finite, in-range lat/lng, and not 0,0 (the "no location" default some devices/bulk paths send).
 */
export function isRealFix(g: unknown): g is { lat: number; lng: number } {
  return !!g && typeof g === 'object' && isUsableReference(g as { lat: number; lng: number });
}

/** Freshness window for a fix (KYC board photo, visibility photo / submit fix) when the gate is on. */
export const BOARD_FIX_MAX_AGE_MS = 60 * 60 * 1000;
/** Tolerated "fix taken in the future" (clock jitter between the fix and the phone's submit clock). */
export const BOARD_FIX_FUTURE_SKEW_MS = 10 * 60 * 1000;
/**
 * A phone clock further than this from the server clock is not trusted as the reference — the server clock is used
 * instead. Bounds how far `clientNow` can move the window (a phone set a day wrong cannot make a days-old fix pass).
 */
export const CLIENT_CLOCK_MAX_SKEW_MS = 24 * 60 * 60 * 1000;

export const STALE_BOARD_FIX_MESSAGE =
  'The store board photo location is too old (or has no time) — take a fresh board photo location at the outlet (tap Retry location), then submit again.';

/**
 * True when a fix's timestamp `ts` is within the window. Ages are measured on ONE clock: when the phone sends its own
 * `clientNow` (at submit) and it is within CLIENT_CLOCK_MAX_SKEW_MS of the server clock, age = clientNow − ts (both on
 * the phone clock, so a phone whose clock is off is not falsely refused); otherwise age = serverNow − ts.
 * Not a security boundary — ts itself is client-supplied; the rule exists to refuse an honest OLD fix (a re-KYC
 * pre-fill from days ago), and the 24 h bound keeps `clientNow` from widening it materially.
 */
export function isFreshFixTime(ts: unknown, now: Date = new Date(), clientNow?: unknown): boolean {
  if (typeof ts !== 'string' || !ts) return false;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  let ref = now.getTime();
  if (typeof clientNow === 'string' && clientNow) {
    const c = Date.parse(clientNow);
    if (Number.isFinite(c) && Math.abs(c - ref) <= CLIENT_CLOCK_MAX_SKEW_MS) ref = c;
  }
  const age = ref - t;
  return age <= BOARD_FIX_MAX_AGE_MS && age >= -BOARD_FIX_FUTURE_SKEW_MS;
}

/** True when the tenant requires location AND the caller is a sales rep (the only gated initiator). */
export function isLocationRequiredFor(features: unknown, role: string | null | undefined): boolean {
  const f = (features ?? {}) as Record<string, unknown>;
  return f[LOCATION_REQUIRED_FEATURE] === true && typeof role === 'string' && role.startsWith('SALES_');
}

export interface FenceBlockRecord {
  actorId: string;
  clientId: string;
  flow: 'KYC' | 'VISIBILITY';
  outletId: string;
  distanceM: number | null;
  accuracyM: number | null;
}

const logger = new Logger('LocationGate');

/**
 * Record one "outside the fence" refusal. BEST-EFFORT: awaited (so tests and the report see it) but never throws —
 * the rep still gets the same refusal message if the audit write fails (logged).
 */
export async function recordFenceBlock(prisma: Pick<PrismaService, 'auditLog'>, r: FenceBlockRecord): Promise<void> {
  const round = (n: number | null) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : null);
  try {
    await prisma.auditLog.create({
      data: {
        action: 'REJECT',
        entityType: FENCE_BLOCK_ENTITY,
        entityId: r.outletId,
        actorId: r.actorId,
        metadata: {
          flow: r.flow,
          clientId: r.clientId,
          distanceM: round(r.distanceM),
          accuracyM: round(r.accuracyM),
        },
      },
    });
  } catch (e) {
    logger.warn(`fence-block audit write failed (${r.flow}, ${r.clientId}): ${(e as Error)?.message ?? e}`);
  }
}
