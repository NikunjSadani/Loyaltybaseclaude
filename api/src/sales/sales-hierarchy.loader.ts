import type { Prisma } from '@prisma/client';
import { HIERARCHY_MAX_HOPS } from './sales-hierarchy-access.helper';

/**
 * G3 (PLATFORM-WIDE, owner-approved 2026-11-17) — the ONE tenant reporting-tree read every hierarchy
 * walker uses (downline scope, member guard, approver walk, team lists, leaderboard, visibility,
 * scheme reach, redemption scope).
 *
 * It deliberately loads SOFT-DELETED nodes too (with `deletedAt`), so the pure helpers in
 * sales-hierarchy-access.helper.ts can walk THROUGH a resigned middle manager — an ASM above a deleted
 * SO keeps that SO's ISRs — while never returning the deleted node as a member/approver/reportee. This
 * mirrors KycService.resolveInitialRouting, which escalates past deleted/inactive managers.
 *
 * Tenant-scoped by the SalesUser.clientId column (the tenant slug — the same key every SalesUser read in
 * the KYC gate uses). Never filter `deletedAt: null` on a read that feeds a walk: that is what cut teams
 * off from the managers above.
 */
export const SALES_HIERARCHY_SELECT = {
  id: true,
  reportingToId: true,
  userId: true,
  isActive: true,
  deletedAt: true,
} as const satisfies Prisma.SalesUserSelect;

export interface SalesHierarchyNode {
  id: string;
  reportingToId: string | null;
  userId: string;
  isActive: boolean;
  deletedAt: Date | null;
}

/** Anything with a Prisma `salesUser` delegate (PrismaService, a transaction client). */
export type SalesHierarchyReader = { salesUser: Pick<Prisma.TransactionClient['salesUser'], 'findMany'> };

export async function loadSalesHierarchy(
  prisma: SalesHierarchyReader,
  clientId: string,
): Promise<SalesHierarchyNode[]> {
  const rows = await prisma.salesUser.findMany({ where: { clientId }, select: SALES_HIERARCHY_SELECT });
  return Array.isArray(rows) ? (rows as SalesHierarchyNode[]) : [];
}

/** The "reporting manager" card fields (name + phone + designation) shown to a rep / partner. */
export const DISPLAY_MANAGER_SELECT = {
  id: true,
  employeeCode: true,
  user: { select: { name: true, phone: true } },
  hierarchyLevel: { select: { name: true, level: true } },
} as const satisfies Prisma.SalesUserSelect;

export type DisplayManager = Prisma.SalesUserGetPayload<{ select: typeof DISPLAY_MANAGER_SELECT }>;

/**
 * R3 (G3) — the manager to DISPLAY for a rep whose DIRECT manager is vacant (soft-deleted or deactivated):
 * the next ACTIVE, non-deleted manager walking up from that vacant manager — the exact rule
 * KycService.resolveInitialRouting uses to pick the approver, so the name a rep sees is the person their
 * KYCs actually go to. Never a deleted person; null only when nobody active exists above.
 *
 * F5 (perf) — walks UP by primary-key lookups (one indexed `findFirst` per hop, bounded by
 * HIERARCHY_MAX_HOPS, tenant-scoped, cycle-safe) instead of loading the whole tenant (~1,050 rows) per call.
 * Chosen over a per-tenant TTL cache: no cross-instance staleness after a hierarchy edit (Cloud Run runs
 * several instances and there is no hierarchy-write hook to invalidate on), and it costs nothing on the
 * common path (callers take a fast path when the direct manager is already live + active). `memo` (keyed by
 * the vacant manager's id) dedupes repeated walks inside one request (the partner "my sales team" card).
 *
 * @param startManagerId  the rep's vacant DIRECT manager (checked first, then upward)
 */
export async function resolveNextActiveManager(
  prisma: { salesUser: Pick<Prisma.TransactionClient['salesUser'], 'findFirst'> },
  clientId: string,
  startManagerId: string,
  memo?: Map<string, Promise<DisplayManager | null>>,
): Promise<DisplayManager | null> {
  const hit = memo?.get(startManagerId);
  if (hit) return hit;
  const run = (async () => {
    const seen = new Set<string>();
    let cur: string | null = startManagerId;
    for (let hops = 0; cur && hops < HIERARCHY_MAX_HOPS; hops++) {
      if (seen.has(cur)) return null; // cycle guard
      seen.add(cur);
      const node = (await prisma.salesUser.findFirst({
        where: { id: cur, clientId },
        select: { ...DISPLAY_MANAGER_SELECT, isActive: true, deletedAt: true, reportingToId: true },
      })) as (DisplayManager & { isActive: boolean; deletedAt: Date | null; reportingToId: string | null }) | null;
      if (!node) return null; // dangling / foreign-tenant reference
      if (node.isActive && node.deletedAt == null) {
        const { isActive: _a, deletedAt: _d, reportingToId: _r, ...display } = node;
        return display as DisplayManager;
      }
      cur = node.reportingToId; // vacant level → keep walking (routing's rule)
    }
    return null;
  })();
  memo?.set(startManagerId, run);
  return run;
}
