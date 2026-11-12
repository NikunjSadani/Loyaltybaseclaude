import { Prisma } from '@prisma/client';
import { AppliesToInput, normalizeAppliesTo } from './applies-to';

/**
 * Prisma `Outlet` where-fragment equivalent to `appliesToOutlet` (plan §2):
 *   AND across non-empty facets; within a facet an OR of `{ equals: v, mode: 'insensitive' }`.
 *   An unscoped AppliesTo → `{}` (no restriction). NULL outlet values never match a non-empty
 *   facet (D4) because `equals` excludes NULL.
 *
 * Merge with the caller's own filters via `AND: [callerWhere, appliesToOutletWhere(scope)]`
 * (never spread — the caller may already use top-level OR/AND).
 *
 * Caveat vs the pure helper: the DB comparison does not TRIM the stored outlet value; outlet
 * master writes store trimmed values, so this only differs for hand-edited rows.
 */
export function appliesToOutletWhere(scope: AppliesToInput): Prisma.OutletWhereInput {
  const s = normalizeAppliesTo(scope);
  const and: Prisma.OutletWhereInput[] = [];
  if (s.outletTypes.length > 0) {
    and.push({
      outletType: {
        OR: s.outletTypes.map((v) => ({ code: { equals: v, mode: 'insensitive' as const } })),
      },
    });
  }
  if (s.programs.length > 0) {
    and.push({
      OR: s.programs.map((v) => ({ programName: { equals: v, mode: 'insensitive' as const } })),
    });
  }
  if (s.subPrograms.length > 0) {
    and.push({
      OR: s.subPrograms.map((v) => ({ programCategory: { equals: v, mode: 'insensitive' as const } })),
    });
  }
  return and.length === 0 ? {} : { AND: and };
}
