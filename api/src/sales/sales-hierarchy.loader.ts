import type { Prisma } from '@prisma/client';
import { firstActiveApproverId } from './sales-hierarchy-access.helper';

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
 * R3 (G3) — the manager to DISPLAY for a rep: the NEXT ACTIVE manager up the chain, skipping a soft-deleted
 * or deactivated (vacant) level — the exact rule KycService.resolveInitialRouting uses to pick the approver,
 * so the name a rep sees is the person their KYCs actually go to. Never a deleted person; null only when no
 * active manager exists anywhere above (the caller then shows nothing — there is genuinely nobody).
 * Tenant-scoped; cycle-safe (firstActiveApproverId). Callers take a fast path when the direct manager is
 * already live + active, so this two-query walk runs only for a vacant slot.
 */
export async function resolveNextActiveManager(
  prisma: { salesUser: Pick<Prisma.TransactionClient['salesUser'], 'findMany' | 'findFirst'> },
  clientId: string,
  salesUserId: string,
): Promise<DisplayManager | null> {
  const nodes = await loadSalesHierarchy(prisma, clientId);
  const managerId = firstActiveApproverId(salesUserId, nodes);
  if (!managerId) return null;
  const mgr = await prisma.salesUser.findFirst({
    where: { id: managerId, clientId, deletedAt: null, isActive: true },
    select: DISPLAY_MANAGER_SELECT,
  });
  return (mgr as DisplayManager | null) ?? null;
}
