/**
 * Programme roster for an import (plan §7.1 step 4).
 *
 * SINGLE SOURCE for "which outlets are on the roster" and "how a file's customer code finds its outlet". Since the
 * audit fix round (M6) the worker aggregates EVERY customer code (keyed by normalizeOutletCode of the file cell) and
 * the roster is applied at PREVIEW / APPLY time with `normalizedRosterIndex` — so an outlet added after processing is
 * still written, and there is no roster-hash block any more. The worker uses the roster only for its frozen
 * matched/unmatched summary and unmatched.csv.
 */
import type { PrismaService } from '../../prisma/prisma.service';
import { normalizeOutletCode } from './normalize';

/** The roster = every live (deletedAt null) outlet of the tenant. Shared by the worker and the preview/apply. */
export function rosterOutletWhere(clientId: string): { clientId: string; deletedAt: null } {
  return { clientId, deletedAt: null };
}

/**
 * normalizeOutletCode(stored Outlet.outletCode) → the stored code. When two stored codes normalize to the same key
 * (e.g. "123" and " 123"), the first in ascending stored-code order wins — deterministic for worker and apply alike.
 */
export function normalizedRosterIndex(outletCodes: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of [...outletCodes].sort()) {
    const n = normalizeOutletCode(c);
    if (n !== '' && !out.has(n)) out.set(n, c);
  }
  return out;
}

export interface Roster {
  /** normalizeOutletCode(code) → Outlet.outletCode as stored. */
  byNormalizedCode: Map<string, string>;
}

/** Live (non-deleted) outlets of the tenant. */
export async function loadRoster(prisma: Pick<PrismaService, 'outlet'>, clientId: string): Promise<Roster> {
  const rows = await prisma.outlet.findMany({ where: rosterOutletWhere(clientId), select: { outletCode: true } });
  return { byNormalizedCode: normalizedRosterIndex(rows.map((r) => r.outletCode)) };
}
