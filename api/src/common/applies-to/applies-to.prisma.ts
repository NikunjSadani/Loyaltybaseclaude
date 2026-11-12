import { Prisma } from '@prisma/client';
import { AppliesToInput, normalizeAppliesTo } from './applies-to';

/**
 * Escape a value for use as a LITERAL inside a Postgres LIKE/ILIKE pattern (default escape char `\`).
 *
 * WHY: Prisma's `{ equals: v, mode: 'insensitive' }` on PostgreSQL compiles to `"col" ILIKE $1` with
 * the value bound VERBATIM (verified 2026-11-12 against the installed Prisma 7.8.0 query compiler by
 * capturing the SQL through a stub driver adapter:
 *   `WHERE "public"."outlets"."programName" ILIKE $1`  args: ["R_P%"]).
 * Unescaped, `_` / `%` in a scope value would act as wildcards (e.g. type `SSS_TOT` would also match
 * `SSSXTOT`) and a `\` would start an escape — diverging from the exact ci compare of the pure helper.
 * Escaping `\`, `%`, `_` makes the ILIKE an exact case-insensitive equality.
 */
export function escapeLikeLiteral(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `{ equals: <escaped>, mode: 'insensitive' }` — an exact ci equality on PostgreSQL (see above). */
function ciEquals(v: string): { equals: string; mode: 'insensitive' } {
  return { equals: escapeLikeLiteral(v), mode: 'insensitive' as const };
}

/**
 * Prisma `Outlet` where-fragment equivalent to `appliesToOutlet` (plan §2):
 *   AND across non-empty facets; within a facet an OR of exact case-insensitive equalities.
 *   An unscoped AppliesTo → `{}` (no restriction). NULL outlet values never match a non-empty
 *   facet (D4) because ILIKE excludes NULL.
 *
 * Merge with the caller's own filters via `AND: [callerWhere, appliesToOutletWhere(scope)]`
 * (never spread — the caller may already use top-level OR/AND).
 *
 * TRIM equivalence with the in-memory helper (which trims the outlet value): the DB side compares
 * the STORED value untrimmed, and the two agree because every application writer of
 * Outlet.programName / programCategory stores TRIMMED values (blank → NULL) — admin-outlets bulk
 * upload (`mapRow` → `nullIfBlank`) and single-record edit (`nullIfBlank`); no other writer sets
 * these columns (asserted in admin-outlets.service.spec "APPLIES-TO trim guarantee"). Outlet type
 * codes are system identifiers (no surrounding whitespace). Scope values themselves are trimmed by
 * normalizeAppliesTo.
 */
export function appliesToOutletWhere(scope: AppliesToInput): Prisma.OutletWhereInput {
  const s = normalizeAppliesTo(scope);
  const and: Prisma.OutletWhereInput[] = [];
  if (s.outletTypes.length > 0) {
    and.push({
      outletType: {
        OR: s.outletTypes.map((v) => ({ code: ciEquals(v) })),
      },
    });
  }
  if (s.programs.length > 0) {
    and.push({
      OR: s.programs.map((v) => ({ programName: ciEquals(v) })),
    });
  }
  if (s.subPrograms.length > 0) {
    and.push({
      OR: s.subPrograms.map((v) => ({ programCategory: ciEquals(v) })),
    });
  }
  return and.length === 0 ? {} : { AND: and };
}
