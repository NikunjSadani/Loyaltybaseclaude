/**
 * Programme roster for an import (plan §7.1 step 4).
 *
 * SINGLE SOURCE for "which outlets are on the roster" and "how a file's customer code finds its outlet".
 * Roster-only aggregates (owner decision 2026-11-23, replacing M6 "aggregate every customer code"): the worker keeps
 * per-product aggregates ONLY for codes on the roster at processing time (keyed by normalizeOutletCode of the file
 * cell) and records that roster on the import (SalesImport.processedRosterCodes). Preview / apply still map the
 * aggregates onto the roster as it is THEN with `normalizedRosterIndex` (an outlet removed since is not written), and
 * count the outlets on today's roster that were NOT on the processing-time roster (`outletsMissingFromProcessing`):
 * their sales in the file are not included, and both screens say so. NULL processedRosterCodes = an import processed
 * before this change: its aggregates cover every customer, so nothing is missing (the old M6 behaviour).
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

/** The processing-time roster to store on the import (SalesImport.processedRosterCodes): sorted normalized codes. */
export function processedRosterCodesOf(byNormalizedCode: ReadonlyMap<string, string>): string[] {
  return [...byNormalizedCode.keys()].sort();
}

/**
 * SalesImport.processedRosterCodes → the set, or null for an import processed BEFORE roster-only aggregates (column
 * NULL / absent: its aggregates cover every customer code). A malformed value is treated as an EMPTY roster (every
 * outlet then counts as missing — loud, never a silent "nothing missing").
 */
export function processedRosterSet(value: unknown): Set<string> | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((v): v is string => typeof v === 'string'));
}

/**
 * How many outlets on the roster NOW were NOT on the roster when the import was processed (so the import has no
 * aggregates for them: their sales in the file are not included). `currentIndex` = normalizedRosterIndex of today's
 * roster. null = a legacy import (every customer was aggregated) → nothing is missing.
 */
export function outletsMissingFromProcessing(processed: ReadonlySet<string> | null, currentIndex: ReadonlyMap<string, string>): number | null {
  if (processed === null) return null;
  let n = 0;
  for (const code of currentIndex.keys()) if (!processed.has(code)) n++;
  return n;
}
