import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Shared `program` filter plumbing for the admin dashboards (Overview `/kpis`, `/program-health`,
 * `/billing-progress`). Mirrors the KYC dashboard's program filter (AdminCoreService.kycDashboard), with
 * whitespace tolerance:
 *   - the filter value is a TRIMMED Outlet.programName; it matches EVERY stored raw variant that trims to it
 *     ("Gold", "Gold ", " Gold" are one program — see `loadProgramCatalog`);
 *   - '' / whitespace / absent = no filter (the response is byte-identical to the unfiltered one);
 *   - an unknown program is NOT an error — it simply matches no outlet, so every number is 0;
 *   - the dropdown source (`availablePrograms`) is the tenant's distinct TRIMMED, non-empty
 *     Outlet.programName values, never narrowed by the active filter.
 * (The KYC dashboard keeps its own exact-match filter — unchanged.)
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
 * The LIVE-outlet condition shared by the billing roster and the partner-level program match: not deleted,
 * not deactivated, not PARKED / NOT_INTERESTED. NEVER `isActive:true` (that would drop KYC-pending outlets,
 * which do bill). `kycIntent notIn` drops NULL rows in Prisma, so it is OR-wrapped with the (majority)
 * NULL-intent branch.
 */
export function liveOutletWhere(): Prisma.OutletWhereInput {
  return {
    deletedAt: null,
    deactivatedAt: null,
    OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
  };
}

export interface ProgramCatalog {
  /** Distinct trimmed, non-empty program names, sorted. */
  available: string[];
  /** Every stored raw Outlet.programName that trims to `program` ([] for an unknown program). */
  variantsOf(program: string): string[];
}

/**
 * One query: the tenant's raw distinct Outlet.programName values (non-deleted outlets), folded by trim.
 */
export async function loadProgramCatalog(prisma: PrismaService, clientId: string): Promise<ProgramCatalog> {
  const rows = await prisma.outlet.findMany({
    where: { clientId, deletedAt: null, programName: { not: null } },
    select: { programName: true },
    distinct: ['programName'],
    orderBy: { programName: 'asc' },
  });
  const byTrimmed = new Map<string, string[]>();
  for (const r of rows ?? []) {
    const raw = r.programName;
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (!t) continue;
    const list = byTrimmed.get(t) ?? [];
    if (!list.includes(raw)) list.push(raw);
    byTrimmed.set(t, list);
  }
  const available = [...byTrimmed.keys()].sort((a, b) => a.localeCompare(b));
  return { available, variantsOf: (p) => [...(byTrimmed.get(p.trim()) ?? [])] };
}

/** The dropdown source only (see `loadProgramCatalog`). */
export async function loadAvailablePrograms(prisma: PrismaService, clientId: string): Promise<string[]> {
  return (await loadProgramCatalog(prisma, clientId)).available;
}

/** Outlet `programName` condition for the selected program's raw variants (`in: []` = matches nothing). */
export function programNameIn(variants: readonly string[]): { in: string[] } {
  return { in: [...variants] };
}

/**
 * Relation filter tying a ChannelPartner to the selected program via the LIVE outlets it OWNS
 * (OutletOwner → Outlet.programName ∈ variants, live-outlet condition). GRAIN NOTE (same as the KYC dashboard):
 * a partner owning outlets in two programs counts in EACH program, so per-program figures need not sum to
 * the total. A partner whose only outlet in the program is deleted / parked / not-interested does NOT count.
 * Returns `{}` when unfiltered (`variants` null) so the caller's `where` is unchanged.
 */
export function partnerProgramScope(
  variants: readonly string[] | null,
): { outlets?: { some: Prisma.OutletWhereInput } } {
  return variants ? { outlets: { some: { programName: programNameIn(variants), ...liveOutletWhere() } } } : {};
}
