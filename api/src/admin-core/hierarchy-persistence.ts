/**
 * hierarchy-persistence.ts — ported locally from
 * platform/src/lib/hierarchy-persistence.ts + the DEOLEO_HIERARCHY config +
 * the HierarchyEmployee / TenantHierarchyLevel types from platform/src/types.
 *
 * Only the persistence path used by admin/hierarchy-config PUT is ported here
 * (the large Excel validation / template generators in employee-hierarchy.ts
 * are NOT needed by the API route and are omitted).
 *
 * Persists the employee-hierarchy JSON snapshot into the RELATIONAL tables —
 * SalesHierarchyLevel, User, SalesUser — in one transaction. Tenant-scoped.
 * Idempotent.
 */

import type { Prisma, UserRole } from '@prisma/client';

// ─── Ported types (from platform/src/types) ───────────────────────────────────

export interface TenantHierarchyLevel {
  tenantId: string;
  level: number;
  roleCode: string;
  roleLabel: string;
  isLeaf: boolean;
  isRoot: boolean;
}

export interface HierarchyEmployee {
  id: string;
  tenantId?: string;
  roleCode: string;
  roleLabel?: string;
  reportsToId: string | null;
  hierarchyPath?: string;
  name: string | null;
  mobile: string | null;
  status?: string; // 'ACTIVE' | 'PLACEHOLDER' | ...
  hasOutlets?: boolean;
  hasSubReports?: boolean;
}

// ─── Deoleo hierarchy config (tenant default) ─────────────────────────────────
// XSR < SO < ASM < RSM < ZNM < NSM
export const DEOLEO_HIERARCHY: TenantHierarchyLevel[] = [
  { tenantId: 'deoleo', level: 1, roleCode: 'XSR', roleLabel: 'XSR', isLeaf: true, isRoot: false },
  { tenantId: 'deoleo', level: 2, roleCode: 'SO', roleLabel: 'SO', isLeaf: false, isRoot: false },
  { tenantId: 'deoleo', level: 3, roleCode: 'ASM', roleLabel: 'ASM', isLeaf: false, isRoot: false },
  { tenantId: 'deoleo', level: 4, roleCode: 'RSM', roleLabel: 'RSM', isLeaf: false, isRoot: false },
  { tenantId: 'deoleo', level: 5, roleCode: 'ZNM', roleLabel: 'ZNM', isLeaf: false, isRoot: false },
  { tenantId: 'deoleo', level: 6, roleCode: 'NSM', roleLabel: 'NSM', isLeaf: false, isRoot: true },
];

// ─── Pure: level rows ─────────────────────────────────────────────────────────

export interface LevelRow {
  code: string;
  name: string;
  level: number;
}

/** Tenant hierarchy config → the SalesHierarchyLevel rows to upsert (sorted by level). */
export function buildLevelRows(config: TenantHierarchyLevel[]): LevelRow[] {
  return [...config]
    .sort((a, b) => a.level - b.level)
    .map((l) => ({ code: l.roleCode, name: l.roleLabel, level: l.level }));
}

// ─── Pure: fine role code → coarse UserRole bucket ────────────────────────────

export function mapRoleCodeToUserRole(roleCode: string): UserRole {
  switch (roleCode.trim().toUpperCase()) {
    case 'NSM':
      return 'SALES_HO';
    case 'ZNM':
    case 'RSM':
      return 'SALES_STATE_HEAD';
    case 'ASM':
      return 'SALES_ASM';
    case 'SO':
      return 'SALES_SO';
    case 'XSR':
    default:
      return 'SALES_ISR';
  }
}

// ─── Pure: reporting-link resolution (two-pass mirror) ────────────────────────

export interface ReportingLink {
  employeeCode: string;
  managerEmployeeCode: string | null;
}

export function resolveReportingLinks(
  employees: Pick<HierarchyEmployee, 'id' | 'reportsToId'>[],
): ReportingLink[] {
  const present = new Set(employees.map((e) => e.id));
  return employees.map((e) => ({
    employeeCode: e.id,
    managerEmployeeCode:
      e.reportsToId && present.has(e.reportsToId) ? e.reportsToId : null,
  }));
}

// ─── Pure: synthetic placeholder phone ────────────────────────────────────────

export function syntheticPlaceholderPhone(employeeCode: string): string {
  return `__vacant__:${employeeCode}`;
}

// ─── Wired: persist into relational tables ────────────────────────────────────

export interface PersistHierarchyResult {
  levelsUpserted: number;
  usersUpserted: number;
  salesUsersUpserted: number;
  reportingLinksSet: number;
  placeholders: number;
}

/**
 * Persist the hierarchy into the relational tree for one tenant, in a single
 * transaction. Idempotent: re-running with the same input converges.
 *
 * `tx` is the Prisma transaction client supplied by `prisma.$transaction(...)`.
 */
export async function persistHierarchy(
  clientId: string,
  employees: HierarchyEmployee[],
  config: TenantHierarchyLevel[],
  tx: Prisma.TransactionClient,
): Promise<PersistHierarchyResult> {
  const levelRows = buildLevelRows(config);

  // ── 1. Levels ────────────────────────────────────────────────────────────
  const levelIdByCode = new Map<string, string>();
  for (const lr of levelRows) {
    const level = await tx.salesHierarchyLevel.upsert({
      where: { clientId_code: { clientId, code: lr.code } },
      update: { name: lr.name, level: lr.level },
      create: { clientId, code: lr.code, name: lr.name, level: lr.level },
    });
    levelIdByCode.set(lr.code.toUpperCase(), level.id);
  }

  // ── 2. Users + SalesUsers (first pass, no reporting links yet) ────────────
  let usersUpserted = 0;
  let salesUsersUpserted = 0;
  let placeholders = 0;
  const salesUserIdByCode = new Map<string, string>();

  for (const emp of employees) {
    const levelId = levelIdByCode.get(emp.roleCode.trim().toUpperCase());
    if (!levelId) {
      // Role not in tenant config — skip rather than crash.
      continue;
    }

    const isPlaceholder = emp.status === 'PLACEHOLDER' || (!emp.name && !emp.mobile);
    if (isPlaceholder) placeholders++;

    const phone = emp.mobile ?? syntheticPlaceholderPhone(emp.id);
    const name = emp.name ?? `(vacant) ${emp.id}`;
    const userRole = mapRoleCodeToUserRole(emp.roleCode);
    const userStatus = isPlaceholder ? 'INACTIVE' : 'ACTIVE';

    const user = await tx.user.upsert({
      where: { clientId_phone: { clientId, phone } },
      update: { name, role: userRole, status: userStatus },
      create: { clientId, phone, name, role: userRole, status: userStatus },
    });
    usersUpserted++;

    const salesUser = await tx.salesUser.upsert({
      where: { clientId_employeeCode: { clientId, employeeCode: emp.id } },
      update: {
        userId: user.id,
        hierarchyLevelId: levelId,
        isActive: !isPlaceholder,
        deletedAt: null,
      },
      create: {
        clientId,
        employeeCode: emp.id,
        userId: user.id,
        hierarchyLevelId: levelId,
        isActive: !isPlaceholder,
      },
    });
    salesUsersUpserted++;
    salesUserIdByCode.set(emp.id, salesUser.id);
  }

  // ── 3. Second pass: reporting links ──────────────────────────────────────
  let reportingLinksSet = 0;
  const links = resolveReportingLinks(
    employees.filter((e) => salesUserIdByCode.has(e.id)),
  );
  for (const link of links) {
    const selfId = salesUserIdByCode.get(link.employeeCode);
    if (!selfId) continue;
    const managerId = link.managerEmployeeCode
      ? salesUserIdByCode.get(link.managerEmployeeCode) ?? null
      : null;
    await tx.salesUser.update({
      where: { id: selfId },
      data: { reportingToId: managerId },
    });
    if (managerId) reportingLinksSet++;
  }

  return {
    levelsUpserted: levelRows.length,
    usersUpserted,
    salesUsersUpserted,
    reportingLinksSet,
    placeholders,
  };
}
