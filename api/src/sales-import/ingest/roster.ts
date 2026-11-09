/**
 * Programme roster for an import (plan §7.1 step 4) + its hash (R-7). The SAME hash function must be used
 * by the preview/apply (Lane K) to detect ROSTER_CHANGED: export it from here, do not re-implement.
 */
import { createHash } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { normalizeOutletCode } from './normalize';

/**
 * sha256 hex of the roster outletCodes sorted ascending as strings and joined by "\n" — byte-identical to
 * Lane K's `rosterHashOf(codes)` (kpi/sales-kpi.helper.ts). No de-duplication (codes are unique per
 * tenant anyway): any divergence would make every month ROSTER_CHANGED and block apply.
 * Input = the raw Outlet.outletCode of every live (deletedAt null) outlet of the tenant.
 */
export function computeRosterHash(outletCodes: Iterable<string>): string {
  const sorted = [...outletCodes].sort();
  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

/** Lane K's name for the same function. */
export const rosterHashOf = computeRosterHash;

export interface Roster {
  /** normalizeOutletCode(code) → Outlet.outletCode as stored. */
  byNormalizedCode: Map<string, string>;
  rosterHash: string;
}

/** Live (non-deleted) outlets of the tenant. */
export async function loadRoster(prisma: Pick<PrismaService, 'outlet'>, clientId: string): Promise<Roster> {
  const rows = await prisma.outlet.findMany({ where: { clientId, deletedAt: null }, select: { outletCode: true } });
  const byNormalizedCode = new Map<string, string>();
  for (const r of rows) {
    const n = normalizeOutletCode(r.outletCode);
    if (n !== '' && !byNormalizedCode.has(n)) byNormalizedCode.set(n, r.outletCode);
  }
  return { byNormalizedCode, rosterHash: computeRosterHash(rows.map((r) => r.outletCode)) };
}
