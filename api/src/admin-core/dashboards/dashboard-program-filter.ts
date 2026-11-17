import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Shared `program` filter plumbing for the admin dashboards (Overview `/kpis`, `/program-health`,
 * `/billing-progress`). Mirrors the KYC dashboard's program filter (AdminCoreService.kycDashboard):
 *   - the filter value is an exact Outlet.programName;
 *   - '' / whitespace / absent = no filter (the response is byte-identical to the unfiltered one);
 *   - an unknown program is NOT an error — it simply matches no outlet, so every number is 0;
 *   - the dropdown source (`availablePrograms`) is the tenant's real distinct Outlet.programName values,
 *     never narrowed by the active filter.
 */

/** Longest accepted filter value (program names are short labels; this only blocks abuse). */
export const DASHBOARD_FILTER_MAX_LEN = 200;

/**
 * Normalise an optional string query param: absent / '' / whitespace → null; otherwise the trimmed value.
 * Throws 400 for a non-string (e.g. a repeated `?program=a&program=b`) or an over-long value.
 */
export function normalizeFilterParam(raw: unknown, name: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new BadRequestException(`\`${name}\` must be a single text value.`);
  const v = raw.trim();
  if (v.length === 0) return null;
  if (v.length > DASHBOARD_FILTER_MAX_LEN) {
    throw new BadRequestException(`\`${name}\` is too long (max ${DASHBOARD_FILTER_MAX_LEN} characters).`);
  }
  return v;
}

/**
 * The tenant's full, sorted list of real distinct Outlet.programName values (same query as the KYC
 * dashboard's dropdown source): non-deleted outlets, NULL / blank names dropped.
 */
export async function loadAvailablePrograms(prisma: PrismaService, clientId: string): Promise<string[]> {
  const rows = await prisma.outlet.findMany({
    where: { clientId, deletedAt: null, programName: { not: null } },
    select: { programName: true },
    distinct: ['programName'],
    orderBy: { programName: 'asc' },
  });
  return (rows ?? [])
    .map((r) => r.programName)
    .filter((p): p is string => !!p && p.trim().length > 0);
}

/**
 * Relation filter tying a ChannelPartner to the selected program via the outlets it OWNS
 * (OutletOwner → Outlet.programName). GRAIN NOTE (same as the KYC dashboard): a partner owning
 * outlets in two programs counts in EACH program, so per-program figures need not sum to the total.
 * Returns `{}` when unfiltered so the caller's `where` is unchanged.
 */
export function partnerProgramScope(program: string | null): { outlets?: { some: { programName: string } } } {
  return program ? { outlets: { some: { programName: program } } } : {};
}
