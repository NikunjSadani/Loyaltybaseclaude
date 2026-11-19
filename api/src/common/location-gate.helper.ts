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
