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

import { BadRequestException } from '@nestjs/common';
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

  // ── 0. Validate phone ↔ employeeCode uniqueness BEFORE any write ──────────
  // A phone number is a person's login, so it must map to exactly ONE employee per
  // tenant. SalesUser.userId is @unique and User is keyed on (clientId, phone); if a
  // phone in the upload already belongs to a different employee code (or a non-sales
  // account), the salesUser.upsert below explodes with a P2002 on `userId` — surfacing
  // as a raw 500 that also rolls back the snapshot ("0 after refresh"). Reject those
  // conflicts up-front with a clean, actionable 400 instead. Resolve each employee's
  // REAL phone here (blank/empty = no phone → a unique synthetic placeholder is used in
  // the loop, never a shared empty string that would collapse many users into one).
  // employeeCode is the stable business key and is uniquely constrained as
  // (clientId, employeeCode). A blank id would upsert SalesUser with employeeCode='' and a
  // synthetic phone '__vacant__:undefined'; two such rows collide → P2002 on employeeCode
  // (the SAME 500/"0 after refresh" symptom this guard targets, just a different column).
  // A duplicate id would upsert the same code twice, orphaning the first user. The chain
  // parser already enforces this, but the PUT body is raw/untrusted, so re-assert it here.
  const realPhoneByCode = new Map<string, string>();
  const seenCodes = new Set<string>();
  for (const emp of employees) {
    if (emp == null || typeof emp !== 'object') continue;
    const code = String(emp.id ?? '').trim();
    if (!code) {
      throw new BadRequestException('Every employee must have a non-blank Employee ID.');
    }
    if (seenCodes.has(code)) {
      throw new BadRequestException(
        `Employee ID "${code}" appears more than once in the upload. Each Employee ID must be unique.`,
      );
    }
    seenCodes.add(code);
    const raw = String(emp.mobile ?? '').trim();
    if (raw !== '') realPhoneByCode.set(code, raw);
  }

  // (a) Within-file: the same phone handed to two different employee codes.
  const codesByPhone = new Map<string, string[]>();
  for (const [code, phone] of realPhoneByCode) {
    const arr = codesByPhone.get(phone) ?? [];
    arr.push(code);
    codesByPhone.set(phone, arr);
  }
  const dupInFile = [...codesByPhone.entries()].filter(([, codes]) => codes.length > 1);
  if (dupInFile.length > 0) {
    const detail = dupInFile
      .map(([phone, codes]) => `phone ${phone} → ${codes.join(', ')}`)
      .join('; ');
    throw new BadRequestException(
      `The same phone number is assigned to more than one employee (${detail}). ` +
        `Each phone may belong to only one employee.`,
    );
  }

  // (b) Against the DB: a phone already used by a DIFFERENT employee code, or by a
  // non-sales account (admin/partner). employeeCode is the stable key — an upload may
  // only update the SAME code's existing user, never re-point another user's phone.
  // Re-uploading the same (code, phone) is fine: the existing owner code equals the
  // upload code, so it is not flagged.
  const phones = [...realPhoneByCode.values()];
  if (phones.length > 0) {
    const existingUsers = await tx.user.findMany({
      // Only an ACTIVE user reserves a phone (deactivate-frees-phone feature). An INACTIVE
      // user's freed number must no longer block a hierarchy upload.
      where: { clientId, phone: { in: phones }, status: 'ACTIVE' },
      select: { phone: true, salesUser: { select: { employeeCode: true } } },
    });
    const conflicts: string[] = [];
    for (const u of existingUsers) {
      const uploadCode = codesByPhone.get(u.phone)?.[0]; // unique by (a) above
      const ownerCode = u.salesUser?.employeeCode ?? null;
      if (ownerCode !== uploadCode) {
        conflicts.push(
          ownerCode
            ? `phone ${u.phone} already belongs to employee ${ownerCode}`
            : `phone ${u.phone} is already used by another account`,
        );
      }
    }
    if (conflicts.length > 0) {
      throw new BadRequestException(
        `Upload rejected — ${conflicts.join('; ')}. ` +
          `A phone number can belong to only one employee; remove or correct it and re-upload.`,
      );
    }
  }

  // ── 1. Levels ────────────────────────────────────────────────────────────
  // The level upsert below re-assigns each code to its config `level`. SalesHierarchyLevel has a
  // SECOND unique on (clientId, level), so if the tenant already has rows with a DIFFERENT
  // code→level arrangement, upserting a code to its target level collides with whatever code
  // currently holds that level (P2002 → the whole tx rolls back → snapshot lost → "0 after
  // refresh"). Free the positive target space first: shift every row that is still at a positive
  // level far negative (a large constant > any real level; config levels are a fixed 1..6 set), so
  // levels 1..N are all free before the upsert. Scoped to `level >= 0` so a row already parked
  // negative by a previous upload (an orphan code no longer in the config) is NOT shifted again —
  // the offset never accumulates across repeated uploads. UPDATE-only (never delete), so
  // SalesUser.hierarchyLevelId FKs stay valid.
  await tx.salesHierarchyLevel.updateMany({
    where: { clientId, level: { gte: 0 } },
    data: { level: { decrement: 1_000_000 } },
  });

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
    // Defensive: the PUT route accepts the raw request body (no DTO transform), so coerce the role
    // code safely and skip null / non-object / missing-roleCode elements instead of crashing on
    // `undefined.trim()`. (Service-layer guard already rejects non-object elements with a 400.)
    if (emp == null || typeof emp !== 'object') continue;
    const roleCode = String(emp.roleCode ?? '').trim().toUpperCase();
    const levelId = levelIdByCode.get(roleCode);
    if (!levelId) {
      // Role not in tenant config (or missing) — skip rather than crash.
      continue;
    }

    // Treat a blank/empty mobile as MISSING (not as the literal ''): an empty string would
    // make every phone-less employee collapse to one User(clientId, '') and trip the
    // SalesUser.userId unique. Use the validated real phone, else a per-code synthetic.
    const realMobile = String(emp.mobile ?? '').trim();
    const isPlaceholder = emp.status === 'PLACEHOLDER' || (!emp.name && !realMobile);
    if (isPlaceholder) placeholders++;

    const phone = realMobile !== '' ? realMobile : syntheticPlaceholderPhone(emp.id);
    const name = emp.name ?? `(vacant) ${emp.id}`;
    const userRole = mapRoleCodeToUserRole(emp.roleCode);
    const userStatus = isPlaceholder ? 'INACTIVE' : 'ACTIVE';

    // Resolve the employee's EXISTING canonical User by the stable business key
    // (clientId, employeeCode). If this employee already has a SalesUser, UPDATE that same
    // User row in place — so a phone correction moves the phone on the SAME row and frees the
    // old number, instead of a phone-keyed upsert CREATING a fresh User and orphaning the old
    // one (its old phone stays reserved in the (clientId, phone) unique, invisible in the UI).
    // The pre-persist guard (§0b) already rejected any upload whose phone belongs to a
    // DIFFERENT code or a non-sales account, so this in-place update never steals a phone.
    // Brand-new employees (no existing SalesUser) keep the phone-keyed upsert, which also
    // correctly reclaims a pre-existing user that happens to already hold that phone.
    const existingSU = await tx.salesUser.findUnique({
      where: { clientId_employeeCode: { clientId, employeeCode: emp.id } },
      select: { userId: true },
    });
    // Brand-new employee (no SalesUser yet): resolve the ACTIVE holder of this phone, if any,
    // and reclaim it in place; otherwise create a fresh User. Phone uniqueness is now the PARTIAL
    // index (WHERE status='ACTIVE'), so the old `clientId_phone` compound upsert no longer exists —
    // and multiple INACTIVE rows may share a phone, so there is no single row to upsert against.
    // §0b already rejected any upload whose phone belongs to a DIFFERENT code or a non-sales
    // account, so an ACTIVE holder here would be a residual edge; reclaiming it (rather than a
    // create that would P2002 on the partial index) keeps the upload robust. A freed INACTIVE
    // number simply creates a fresh row (the stale INACTIVE row no longer reserves the phone).
    let user: { id: string };
    if (existingSU) {
      user = await tx.user.update({
        where: { id: existingSU.userId },
        data: { phone, name, role: userRole, status: userStatus },
      });
    } else {
      const activeHolder = await tx.user.findFirst({
        where: { clientId, phone, status: 'ACTIVE' },
        select: { id: true },
      });
      user = activeHolder
        ? await tx.user.update({
            where: { id: activeHolder.id },
            data: { name, role: userRole, status: userStatus },
          })
        : await tx.user.create({
            data: { clientId, phone, name, role: userRole, status: userStatus },
          });
    }
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
