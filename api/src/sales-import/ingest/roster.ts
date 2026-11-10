/**
 * Programme roster for an import (plan §7.1 step 4) + its hash (R-7).
 *
 * SINGLE SOURCE for the roster fingerprint. The worker stamps `SalesImport.rosterHash` with `rosterHashOf`, and the
 * preview/apply ROSTER_CHANGED check (kpi/sales-import-data.ts) recomputes it with the SAME function over the SAME
 * outlet set (`rosterOutletWhere`). Any divergence would make every month ROSTER_CHANGED and block apply, so both
 * call sites MUST use these two exports; do not re-implement either. Pinned by `roster-hash.parity.spec.ts`.
 */
import { createHash } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service';
import { normalizeOutletCode } from './normalize';

/** The roster = every live (deletedAt null) outlet of the tenant. Shared by the worker and the preview/apply. */
export function rosterOutletWhere(clientId: string): { clientId: string; deletedAt: null } {
  return { clientId, deletedAt: null };
}

/**
 * sha256 hex of the raw `Outlet.outletCode` values of the roster, sorted ascending (JS string order) and joined by
 * "\n". `@@unique([clientId, outletCode])` makes the codes unique, so callers may pass an array or Map keys alike.
 */
export function rosterHashOf(outletCodes: Iterable<string>): string {
  const sorted = [...outletCodes].sort();
  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

export interface Roster {
  /** normalizeOutletCode(code) → Outlet.outletCode as stored. */
  byNormalizedCode: Map<string, string>;
  rosterHash: string;
}

/** Live (non-deleted) outlets of the tenant. */
export async function loadRoster(prisma: Pick<PrismaService, 'outlet'>, clientId: string): Promise<Roster> {
  const rows = await prisma.outlet.findMany({ where: rosterOutletWhere(clientId), select: { outletCode: true } });
  const byNormalizedCode = new Map<string, string>();
  for (const r of rows) {
    const n = normalizeOutletCode(r.outletCode);
    if (n !== '' && !byNormalizedCode.has(n)) byNormalizedCode.set(n, r.outletCode);
  }
  return { byNormalizedCode, rosterHash: rosterHashOf(rows.map((r) => r.outletCode)) };
}
