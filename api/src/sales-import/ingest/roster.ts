/**
 * Programme roster for an import (plan §7.1 step 4) + its hash (R-7). The SAME hash function must be used
 * by the preview/apply (Lane K) to detect ROSTER_CHANGED: export it from here, do not re-implement.
 */
import { createHash } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { normalizeOutletCode } from './normalize';

/** sha256 of the sorted, de-duplicated roster outletCodes joined by "\n". */
export function computeRosterHash(outletCodes: Iterable<string>): string {
  const sorted = [...new Set(outletCodes)].sort();
  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

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
