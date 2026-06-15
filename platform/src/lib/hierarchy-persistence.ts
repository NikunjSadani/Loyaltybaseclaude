/**
 * hierarchy-persistence.ts
 *
 * Persists the employee hierarchy (the JSON snapshot produced by the admin
 * upload) into the RELATIONAL tables — `SalesHierarchyLevel`, `User`,
 * `SalesUser` — so downstream features (outlet-upload XSR validation,
 * `/sales/team`) read a real reporting tree instead of a denormalized blob.
 *
 * Split into two layers:
 *   • PURE mapping/resolution (no DB) — unit-tested directly:
 *       - buildLevelRows()          : tenant config → level rows to upsert
 *       - mapRoleCodeToUserRole()   : fine role code → coarse UserRole enum bucket
 *       - resolveReportingLinks()   : employeeId → manager employeeCode pairs
 *       - syntheticPlaceholderPhone(): deterministic phone for vacant positions
 *   • A thin wired layer — persistHierarchy() — runs the upserts in one
 *     transaction. Tenant-scoped. Idempotent.
 *
 * Design notes (see task brief):
 *   • User identity key is `@@unique([clientId, phone])`. Real employees match
 *     on (clientId, phone). PLACEHOLDER rows have no phone, so we mint a
 *     deterministic synthetic phone from the employeeCode and create an
 *     INACTIVE login User — SalesUser.userId is required+unique, so a userless
 *     SalesUser is impossible; a synthetic inactive User is the documented
 *     choice (it keeps the position/territory in the tree without a real login).
 *   • The fine role (XSR/SO/ASM/RSM/ZNM/NSM) lives on SalesHierarchyLevel.code.
 *     User.role only carries the coarse UserRole bucket; we do NOT add a ZNM
 *     enum value (ZNM maps to SALES_STATE_HEAD on the coarse axis).
 */

import type { HierarchyEmployee, TenantHierarchyLevel } from '@/types';
import type { PrismaClient, UserRole } from '@prisma/client';

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

/**
 * Map a fine hierarchy role code to the coarse `UserRole` enum bucket that best
 * fits. The fine role lives on SalesHierarchyLevel.code; this is only the login
 * role on User.role. Deliberately no ZNM enum value — ZNM (zonal) sits on the
 * state-head coarse rung. Unknown codes fall back to the leaf field role.
 */
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
  /** employeeCode of the manager, or null for a root / unresolved manager. */
  managerEmployeeCode: string | null;
}

/**
 * Second-pass resolution: given the full employee list, produce the
 * employeeCode → managerEmployeeCode links. A manager may be defined anywhere
 * in the list (order-independent). If an employee's reportsToId names a manager
 * that is NOT present in the list, the link resolves to null (root-like) so a
 * dangling reference never crashes persistence — it just leaves reportingToId
 * unset, matching the parser's lenient philosophy.
 *
 * Only employees themselves present in the input get a link entry.
 */
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

/**
 * Deterministic synthetic phone for a vacant (PLACEHOLDER) position, so the
 * `@@unique([clientId, phone])` User constraint is satisfied without colliding
 * with real 10-digit numbers. Prefixed with a non-dialable marker and the
 * employeeCode; idempotent for the same code.
 */
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
 *  1. Upsert one SalesHierarchyLevel per config level (on clientId+code).
 *  2. For each employee: upsert a User (real → match clientId+phone;
 *     placeholder → synthetic inactive User), then upsert a SalesUser
 *     (employeeCode unique, level resolved from roleCode).
 *  3. Second pass: resolve reportingToId from the manager's SalesUser.id.
 *
 * `db` defaults to the lib/prisma singleton but is injectable for the smoke
 * script / tests.
 */
export async function persistHierarchy(
  clientId: string,
  employees: HierarchyEmployee[],
  config: TenantHierarchyLevel[],
  db: PrismaClient,
): Promise<PersistHierarchyResult> {
  const levelRows = buildLevelRows(config);

  return db.$transaction(async (tx) => {
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

      // Upsert User on (clientId, phone).
      const user = await tx.user.upsert({
        where: { clientId_phone: { clientId, phone } },
        update: { name, role: userRole, status: userStatus },
        create: { clientId, phone, name, role: userRole, status: userStatus },
      });
      usersUpserted++;

      // Upsert SalesUser on the per-tenant compound key (clientId, employeeCode).
      // employeeCode is NO LONGER globally unique (RF7) — it is unique within a tenant.
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
  });
}
