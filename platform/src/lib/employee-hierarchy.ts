/**
 * employee-hierarchy.ts
 *
 * Core validation and processing for the employee hierarchy bulk upload.
 * Pure functions — no DOM, no Prisma, safe for use in tests and API routes.
 *
 * Design:
 *  • Two-pass validation: Pass 1 (headers) → Pass 2 (rows).
 *  • All row errors accumulate — the user sees every problem at once.
 *  • Tenant hierarchy config replaces every hardcoded role name.
 *  • Employee IDs are position/territory codes, not person identifiers.
 *  • A manager can be defined anywhere in the same upload file (two-pass safe).
 */

import type {
  TenantHierarchyLevel,
  HierarchyEmployee,
  EmployeeUploadRow,
  EmployeeRowValidationResult,
  EmployeeUploadValidationResult,
} from '@/types';

// ─── Re-export types for convenience ─────────────────────────────────────────

export type { TenantHierarchyLevel, HierarchyEmployee, EmployeeUploadRow };

// ─── Required columns (user-specified order) ─────────────────────────────────

export const REQUIRED_HEADERS = [
  'Hierarchy',
  'Employee ID',
  'Employee Name',
  'Employee Phone Number',
  'Reporting Manager Hierarchy',
  'Reporting Manager Employee ID',
] as const;

// ─── Deoleo hierarchy config (tenant default) ─────────────────────────────────
// ISR < SO < ASM < RSM < ZNM < NSM

export const DEOLEO_HIERARCHY: TenantHierarchyLevel[] = [
  { tenantId: 'deoleo', level: 1, roleCode: 'ISR', roleLabel: 'ISR', isLeaf: true,  isRoot: false },
  { tenantId: 'deoleo', level: 2, roleCode: 'SO',  roleLabel: 'SO',  isLeaf: false, isRoot: false },
  { tenantId: 'deoleo', level: 3, roleCode: 'ASM', roleLabel: 'ASM', isLeaf: false, isRoot: false },
  { tenantId: 'deoleo', level: 4, roleCode: 'RSM', roleLabel: 'RSM', isLeaf: false, isRoot: false },
  { tenantId: 'deoleo', level: 5, roleCode: 'ZNM', roleLabel: 'ZNM', isLeaf: false, isRoot: false },
  { tenantId: 'deoleo', level: 6, roleCode: 'NSM', roleLabel: 'NSM', isLeaf: false, isRoot: true  },
];

// ─── Mock employee store (localStorage-backed for demo) ───────────────────────

const STORE_KEY = 'hierarchy_employees_v1';

export const MOCK_EMPLOYEES: HierarchyEmployee[] = [
  {
    id: 'NSM-01',   tenantId: 'deoleo', roleCode: 'NSM', roleLabel: 'NSM',
    reportsToId: null,       hierarchyPath: '/NSM-01/',
    name: 'Anand Rao',       mobile: '9900000001', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'ZNM-W1',   tenantId: 'deoleo', roleCode: 'ZNM', roleLabel: 'ZNM',
    reportsToId: 'NSM-01',   hierarchyPath: '/NSM-01/ZNM-W1/',
    name: 'Vikram Singh',    mobile: '9900000002', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'RSM-MH',   tenantId: 'deoleo', roleCode: 'RSM', roleLabel: 'RSM',
    reportsToId: 'ZNM-W1',  hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/',
    name: 'Suresh Nair',     mobile: '9900000003', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'ASM-MUM',  tenantId: 'deoleo', roleCode: 'ASM', roleLabel: 'ASM',
    reportsToId: 'RSM-MH',  hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-MUM/',
    name: 'Priya Mehta',     mobile: '9900000007', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'ASM-PUN',  tenantId: 'deoleo', roleCode: 'ASM', roleLabel: 'ASM',
    reportsToId: 'RSM-MH',  hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-PUN/',
    name: 'Anita Desai',     mobile: '9900000008', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'SO-MUM1',  tenantId: 'deoleo', roleCode: 'SO',  roleLabel: 'SO',
    reportsToId: 'ASM-MUM', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-MUM/SO-MUM1/',
    name: 'Rajesh Kumar',    mobile: '9900000028', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'SO-PUN1',  tenantId: 'deoleo', roleCode: 'SO',  roleLabel: 'SO',
    reportsToId: 'ASM-PUN', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-PUN/SO-PUN1/',
    name: 'Ramesh Gupta',    mobile: '9900000029', status: 'ACTIVE',
    hasOutlets: false,       hasSubReports: true,
  },
  {
    id: 'SO-MUM2',  tenantId: 'deoleo', roleCode: 'SO',  roleLabel: 'SO',
    reportsToId: 'ASM-MUM', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-MUM/SO-MUM2/',
    name: null,              mobile: null,         status: 'PLACEHOLDER',
    hasOutlets: false,       hasSubReports: false,
  },
  {
    id: 'ISR-M001', tenantId: 'deoleo', roleCode: 'ISR', roleLabel: 'ISR',
    reportsToId: 'SO-MUM1', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-MUM/SO-MUM1/ISR-M001/',
    name: 'Anil Sharma',     mobile: '9900000041', status: 'ACTIVE',
    hasOutlets: true,        hasSubReports: false,
  },
  {
    id: 'ISR-M002', tenantId: 'deoleo', roleCode: 'ISR', roleLabel: 'ISR',
    reportsToId: 'SO-MUM1', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-MUM/SO-MUM1/ISR-M002/',
    name: null,              mobile: null,         status: 'PLACEHOLDER',
    hasOutlets: false,       hasSubReports: false,
  },
  {
    id: 'ISR-P001', tenantId: 'deoleo', roleCode: 'ISR', roleLabel: 'ISR',
    reportsToId: 'SO-PUN1', hierarchyPath: '/NSM-01/ZNM-W1/RSM-MH/ASM-PUN/SO-PUN1/ISR-P001/',
    name: 'Sanjay Patel',    mobile: '9900000042', status: 'ACTIVE',
    hasOutlets: true,        hasSubReports: false,
  },
];

export function getEmployees(): HierarchyEmployee[] {
  if (typeof window === 'undefined') return MOCK_EMPLOYEES;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw) as HierarchyEmployee[];
  } catch { /* ignore */ }
  return MOCK_EMPLOYEES;
}

export function saveEmployees(employees: HierarchyEmployee[]): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(employees)); }
  catch { /* ignore */ }
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/** Phone is valid if blank OR exactly 10 digits */
export function validatePhone(phone: string): boolean {
  const t = phone.trim();
  if (t === '') return true;
  return /^\d{10}$/.test(t);
}

/** Strip non-digits for comparison */
export function normalisePhone(phone: string): string {
  return phone.trim().replace(/\D/g, '');
}

/** Case-insensitive role lookup in tenant config */
export function resolveRole(
  roleInput: string,
  config: TenantHierarchyLevel[],
): TenantHierarchyLevel | null {
  const n = roleInput.trim().toUpperCase();
  return config.find(l => l.roleCode.toUpperCase() === n) ?? null;
}

/**
 * Employee ID must contain only word characters (letters, digits, underscores)
 * and hyphens. Spaces, commas, semicolons would corrupt CSV exports.
 */
export function validateEmployeeId(id: string): boolean {
  return /^[\w-]+$/.test(id);
}

// ─── Pass 1: header validation ────────────────────────────────────────────────

/**
 * Returns null if all required headers are present; otherwise returns an
 * error string naming ALL missing columns at once.
 */
export function validateHeaders(headers: string[]): string | null {
  const normalised = headers.map(h => h.trim());
  const missing = (REQUIRED_HEADERS as readonly string[]).filter(h => !normalised.includes(h));
  if (missing.length === 0) return null;
  return (
    `Missing required column(s): ${missing.join(', ')}. ` +
    `Expected columns: ${REQUIRED_HEADERS.join(', ')}.`
  );
}

// ─── Pass 2: row validation ───────────────────────────────────────────────────

/**
 * Validate all upload rows against the tenant hierarchy config and existing
 * employee data.  Pure — no side effects.
 *
 * Key rules enforced:
 *  1. Employee ID required & unique within upload
 *  2. Employee ID format: alphanumeric + hyphens only
 *  3. Phone 10 digits or blank; unique system-wide
 *  4. Hierarchy (role) must match tenant config
 *  5. Root role (NSM) must have no manager columns
 *  6. Non-root roles must have a manager
 *  7. Manager must exist (in system or same upload)
 *  8. Manager hierarchy must be exactly one level above
 *  9. Reporting Manager Hierarchy column must match manager's actual role
 * 10. Employees with outlets cannot change hierarchy
 * 11. Employees with sub-reports cannot change hierarchy
 * 12. Circular dependency detection
 */
export function validateEmployeeUpload(
  rows: EmployeeUploadRow[],
  existingEmployees: HierarchyEmployee[],
  hierarchyConfig: TenantHierarchyLevel[],
): EmployeeUploadValidationResult {

  // ── Build lookups ──────────────────────────────────────────────────────────
  const existingById = new Map<string, HierarchyEmployee>(
    existingEmployees.map(e => [e.id, e]),
  );

  // Existing phones (normalised) → employee id
  const existingPhones = new Map<string, string>(
    existingEmployees
      .filter(e => e.mobile)
      .map(e => [normalisePhone(e.mobile!), e.id]),
  );

  // Also build a map from the entire upload so managers can be defined anywhere
  const uploadById = new Map<string, EmployeeUploadRow>(
    rows
      .filter(r => r.employeeId.trim() !== '')
      .map(r => [r.employeeId.trim(), r]),
  );

  // Track IDs and phones seen within THIS upload
  const seenIds    = new Map<string, number>(); // id  → first rowNum
  const seenPhones = new Map<string, number>(); // normalised phone → first rowNum

  const results: EmployeeRowValidationResult[] = [];

  for (const row of rows) {
    const employeeId  = row.employeeId.trim();
    const hierarchy   = row.hierarchy.trim();
    const name        = row.employeeName.trim();
    const phone       = row.employeePhone.trim();
    const mgrHierarchy = row.reportingManagerHierarchy.trim();
    const mgrId        = row.reportingManagerEmployeeId.trim();

    const errors: string[] = [];
    const warnings: string[] = [];

    // ── Skip entirely blank rows ───────────────────────────────────────────
    if (!employeeId && !hierarchy && !name && !phone && !mgrId && !mgrHierarchy) {
      continue;
    }

    // ── Employee ID ────────────────────────────────────────────────────────
    if (!employeeId) {
      errors.push('Employee ID is required.');
    } else {
      if (!validateEmployeeId(employeeId)) {
        errors.push(
          `Employee ID "${employeeId}" contains invalid characters. ` +
          `Use only letters, digits, underscores, and hyphens (no spaces or commas).`,
        );
      }
      if (seenIds.has(employeeId)) {
        errors.push(
          `Duplicate Employee ID "${employeeId}" — already appears in row ${seenIds.get(employeeId)}.`,
        );
      } else {
        seenIds.set(employeeId, row.rowNum);
      }
    }

    // ── Hierarchy / role ───────────────────────────────────────────────────
    let levelConfig: TenantHierarchyLevel | null = null;
    if (!hierarchy) {
      errors.push('Hierarchy (role) is required.');
    } else {
      levelConfig = resolveRole(hierarchy, hierarchyConfig);
      if (!levelConfig) {
        const valid = hierarchyConfig.map(l => l.roleCode).join(', ');
        errors.push(`"${hierarchy}" is not a valid hierarchy level. Valid levels: ${valid}.`);
      }
    }

    // ── Phone ──────────────────────────────────────────────────────────────
    const normPhone = normalisePhone(phone);
    if (phone !== '' && !validatePhone(phone)) {
      errors.push(
        `Phone "${phone}" must be exactly 10 digits or left blank (no spaces, no +91).`,
      );
    } else if (normPhone !== '') {
      // Phone uniqueness vs existing employees
      const existingOwner = existingPhones.get(normPhone);
      if (existingOwner && existingOwner !== employeeId) {
        errors.push(
          `Phone ${phone} is already registered to employee "${existingOwner}".`,
        );
      }
      // Phone uniqueness within this upload
      if (seenPhones.has(normPhone)) {
        errors.push(
          `Phone ${phone} is duplicated — already used in row ${seenPhones.get(normPhone)}.`,
        );
      } else {
        seenPhones.set(normPhone, row.rowNum);
      }
    }

    // ── Manager rules (only proceed if role resolved cleanly) ─────────────
    if (levelConfig) {
      if (levelConfig.isRoot) {
        // Root (NSM): must NOT have a manager
        if (mgrId) {
          errors.push(
            `${levelConfig.roleCode} is the root level and must not have a ` +
            `Reporting Manager Employee ID.`,
          );
        }
        if (mgrHierarchy) {
          errors.push(
            `${levelConfig.roleCode} is the root level and must not have a ` +
            `Reporting Manager Hierarchy.`,
          );
        }
      } else {
        // Non-root: must HAVE a manager
        if (!mgrId) {
          errors.push(
            `Reporting Manager Employee ID is required for ${levelConfig.roleCode}.`,
          );
        }
        if (!mgrHierarchy) {
          errors.push(
            `Reporting Manager Hierarchy is required for ${levelConfig.roleCode}.`,
          );
        }

        // Manager must exist and be the right level
        if (mgrId) {
          const existingMgr = existingById.get(mgrId);
          const uploadMgr   = uploadById.get(mgrId);

          if (!existingMgr && !uploadMgr) {
            errors.push(
              `Reporting Manager "${mgrId}" not found in the system or in this upload.`,
            );
          } else {
            // Determine manager's role code
            const mgrRoleCode = existingMgr
              ? existingMgr.roleCode
              : resolveRole(uploadMgr!.hierarchy, hierarchyConfig)?.roleCode ?? uploadMgr!.hierarchy.trim().toUpperCase();

            const mgrLevelCfg = resolveRole(mgrRoleCode, hierarchyConfig);

            if (mgrLevelCfg) {
              const expectedLevel = levelConfig.level + 1;
              if (mgrLevelCfg.level !== expectedLevel) {
                const expectedRole = hierarchyConfig.find(l => l.level === expectedLevel);
                errors.push(
                  `${levelConfig.roleCode} must report to ${expectedRole?.roleCode ?? `level ${expectedLevel}`}. ` +
                  `"${mgrId}" is ${mgrLevelCfg.roleCode} (level ${mgrLevelCfg.level}), ` +
                  `but expected level ${expectedLevel}.`,
                );
              }

              // Cross-check: "Reporting Manager Hierarchy" column vs actual role
              if (
                mgrHierarchy &&
                mgrLevelCfg.roleCode.toUpperCase() !== mgrHierarchy.toUpperCase()
              ) {
                errors.push(
                  `Reporting Manager Hierarchy says "${mgrHierarchy}" but ` +
                  `"${mgrId}" is actually ${mgrLevelCfg.roleCode}. Please correct the column.`,
                );
              }
            }

            // Circular dependency check
            if (employeeId && !errors.some(e => e.includes('Circular'))) {
              if (wouldCreateCycle(employeeId, mgrId, existingById, uploadById)) {
                errors.push(
                  `Circular hierarchy detected: setting "${mgrId}" as manager of ` +
                  `"${employeeId}" would create a reporting loop.`,
                );
              }
            }
          }
        }
      }
    }

    // ── Business rules: hierarchy change checks ────────────────────────────
    if (employeeId && levelConfig && errors.length === 0) {
      const existing = existingById.get(employeeId);
      if (existing) {
        const roleChanged    = existing.roleCode.toUpperCase() !== levelConfig.roleCode.toUpperCase();
        const managerChanged = mgrId !== (existing.reportsToId ?? '');

        if (roleChanged || managerChanged) {
          if (existing.hasOutlets) {
            errors.push(
              `"${employeeId}" has outlets assigned. ` +
              `Reassign all outlets before changing their hierarchy position.`,
            );
          }
          if (existing.hasSubReports) {
            errors.push(
              `"${employeeId}" has team members reporting to them. ` +
              `Create a replacement employee first, then move "${employeeId}".`,
            );
          }
        }
      }
    }

    // ── Determine action ───────────────────────────────────────────────────
    let action: EmployeeRowValidationResult['action'] = 'SKIP';

    if (errors.length === 0 && employeeId) {
      const existing = existingById.get(employeeId);
      if (!existing) {
        action = 'CREATE';
      } else {
        const roleChanged    = levelConfig
          ? existing.roleCode.toUpperCase() !== levelConfig.roleCode.toUpperCase()
          : false;
        const managerChanged = mgrId !== (existing.reportsToId ?? '');
        action = (roleChanged || managerChanged) ? 'UPDATE_HIERARCHY' : 'UPDATE_INFO';
      }
    }

    // PLACEHOLDER warning
    if (action === 'CREATE' && !name && !phone) {
      warnings.push('No name or phone provided — this will create a PLACEHOLDER position.');
    }

    results.push({
      rowNum: row.rowNum,
      employeeId,
      status: errors.length > 0 ? 'ERROR' : warnings.length > 0 ? 'WARNING' : 'OK',
      errors,
      warnings,
      action,
    });
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const creates  = results.filter(r => r.action === 'CREATE').length;
  const updates  = results.filter(
    r => r.action === 'UPDATE_INFO' || r.action === 'UPDATE_HIERARCHY',
  ).length;
  const errCount = results.filter(r => r.status === 'ERROR').length;

  return {
    headerError: null,
    rows: results,
    hasErrors: errCount > 0,
    canProceed: errCount === 0 && results.length > 0,
    summary: { total: results.length, creates, updates, errors: errCount },
  };
}

// ─── Circular dependency check ────────────────────────────────────────────────

function wouldCreateCycle(
  employeeId: string,
  proposedManagerId: string,
  existingById: Map<string, HierarchyEmployee>,
  uploadById: Map<string, EmployeeUploadRow>,
  visited = new Set<string>(),
): boolean {
  if (proposedManagerId === employeeId) return true;
  if (visited.has(proposedManagerId)) return false;
  visited.add(proposedManagerId);

  // Find the proposed manager's own manager
  const uploadMgr   = uploadById.get(proposedManagerId);
  const existingMgr = existingById.get(proposedManagerId);

  const nextMgrId = uploadMgr?.reportingManagerEmployeeId.trim()
    || existingMgr?.reportsToId
    || null;

  if (!nextMgrId) return false;
  return wouldCreateCycle(employeeId, nextMgrId, existingById, uploadById, visited);
}

// ─── Hierarchy path computation ───────────────────────────────────────────────

export function computeHierarchyPath(
  employeeId: string,
  reportsToId: string | null,
  existingById: Map<string, HierarchyEmployee>,
): string {
  if (!reportsToId) return `/${employeeId}/`;
  const manager = existingById.get(reportsToId);
  const managerPath = manager ? manager.hierarchyPath : `/${reportsToId}/`;
  return `${managerPath}${employeeId}/`;
}

// ─── Parse Excel rows into EmployeeUploadRow[] ────────────────────────────────

/**
 * Given an array of raw row objects (key = column header, value = cell string),
 * converts them to typed EmployeeUploadRow[]  (row numbers are 1-based).
 */
export function parseUploadRows(
  rawRows: Record<string, string>[],
): EmployeeUploadRow[] {
  return rawRows.map((raw, idx) => ({
    rowNum:                      idx + 2, // row 1 = header
    hierarchy:                   (raw['Hierarchy']                        ?? '').trim(),
    employeeId:                  (raw['Employee ID']                      ?? '').trim(),
    employeeName:                (raw['Employee Name']                    ?? '').trim(),
    employeePhone:               (raw['Employee Phone Number']            ?? '').trim(),
    reportingManagerHierarchy:   (raw['Reporting Manager Hierarchy']      ?? '').trim(),
    reportingManagerEmployeeId:  (raw['Reporting Manager Employee ID']    ?? '').trim(),
  }));
}

// ─── Excel template data ──────────────────────────────────────────────────────

export interface TemplateData {
  headers: readonly string[];
  exampleRows: string[][];
  /** Rows for the Dos & Don'ts sheet (sheet 1). Each inner array is one Excel row. */
  dosAndDontsRows: string[][];
}

/**
 * Returns all content needed to build the two-sheet XLSX template.
 *
 * Sheet order:
 *   Sheet 1 — "Dos & Don'ts"   ← opens first; prevents common mistakes
 *   Sheet 2 — "Employee Upload" ← the data entry sheet
 */
export function getTemplateData(config: TenantHierarchyLevel[]): TemplateData {
  const roles        = config.map(l => l.roleCode);
  const rolesStr     = roles.join(' / ');
  const leafConfig   = config.find(l => l.isLeaf)  ?? config[0];
  const rootConfig   = config.find(l => l.isRoot)  ?? config[config.length - 1];
  const parentOfLeaf = config.find(l => l.level === leafConfig.level + 1);

  // ── Build Dos & Don'ts sheet rows ─────────────────────────────────────────
  // Each row: [col-A content, col-B content]
  // Col A = label/symbol, Col B = explanation (wider column)

  const dosAndDontsRows: string[][] = [
    // Title
    ['EMPLOYEE HIERARCHY UPLOAD — DOS & DON\'TS', ''],
    ['Read this sheet before filling the "Employee Upload" sheet.', ''],
    ['', ''],

    // ── Column Reference ──────────────────────────────────────────────────
    ['━━━  COLUMN REFERENCE  ━━━', ''],
    ['Column', 'Rule'],
    [
      'Hierarchy',
      `REQUIRED. Enter one of: ${rolesStr}. Case-insensitive (e.g. "isr" and "ISR" both work).`,
    ],
    [
      'Employee ID',
      'REQUIRED. A unique position/territory code (e.g. Pune101). ' +
      'Identifies the territory, not the person — the same code can be reused when a person changes. ' +
      'Allowed characters: letters, digits, hyphens (-), underscores (_). NO spaces or commas.',
    ],
    [
      'Employee Name',
      'Optional. Leave blank to create a PLACEHOLDER (vacant position). ' +
      'The hierarchy is maintained even without a person assigned.',
    ],
    [
      'Employee Phone Number',
      'Optional. If provided: exactly 10 digits, NO +91 prefix, NO spaces (e.g. 9876543210). ' +
      'Must be unique across all employees system-wide.',
    ],
    [
      'Reporting Manager Hierarchy',
      `REQUIRED for all levels except ${rootConfig.roleCode}. ` +
      `Must be the role code exactly one level above (e.g. an ${leafConfig.roleCode} must report to ${parentOfLeaf?.roleCode ?? 'the next level'}). ` +
      'This is cross-checked against the manager\'s actual role in the system.',
    ],
    [
      'Reporting Manager Employee ID',
      `REQUIRED for all levels except ${rootConfig.roleCode}. ` +
      `${rootConfig.roleCode} must leave BOTH manager columns completely blank. ` +
      'The manager must exist in the system or appear anywhere in this upload file.',
    ],
    ['', ''],

    // ── DOs ───────────────────────────────────────────────────────────────
    ['━━━  ✓ DOs  ━━━', ''],
    [
      '✓ DO',
      `Start from this template — it always has the correct 6 column headers.`,
    ],
    [
      '✓ DO',
      'Enter data only in the "Employee Upload" sheet. Do NOT rename or delete columns.',
    ],
    [
      '✓ DO',
      `Leave Employee Name and Phone blank if the position is not yet filled. ` +
      'It will be created as a PLACEHOLDER and can be activated later by adding name + phone.',
    ],
    [
      '✓ DO',
      `Leave BOTH Reporting Manager columns blank for ${rootConfig.roleCode} rows only.`,
    ],
    [
      '✓ DO',
      'You can define a manager in a later row of the same file — the system reads the ' +
      'whole file before validating. Order of rows does not matter.',
    ],
    [
      '✓ DO',
      'To edit name or phone for an existing employee: include the same Employee ID with ' +
      'the same Hierarchy and same Reporting Manager. Only name/phone will change.',
    ],
    [
      '✓ DO',
      'To move an employee to a different manager: ensure they have no outlets assigned ' +
      'and no team members reporting to them first.',
    ],
    [
      '✓ DO',
      'To promote an employee (role change): first create a replacement at the old role, ' +
      'then change the original employee\'s Hierarchy and Reporting Manager.',
    ],
    ['', ''],

    // ── DON'Ts ────────────────────────────────────────────────────────────
    ['━━━  ✗ DON\'TS  ━━━', ''],
    [
      '✗ DON\'T',
      'Add +91 or 0 prefix to phone numbers. Enter exactly 10 digits: 9876543210, NOT +919876543210.',
    ],
    [
      '✗ DON\'T',
      'Use spaces, commas, or special characters in Employee ID. Use hyphens instead: Pune-101, NOT "Pune 101".',
    ],
    [
      '✗ DON\'T',
      'Enter the same Employee ID twice in the same file. Duplicates in the upload are rejected.',
    ],
    [
      '✗ DON\'T',
      'Enter the same phone number for two different employees. Phone numbers must be unique.',
    ],
    [
      '✗ DON\'T',
      `Fill the Reporting Manager columns for ${rootConfig.roleCode}. Leave them blank.`,
    ],
    [
      '✗ DON\'T',
      `Skip the Reporting Manager columns for any level other than ${rootConfig.roleCode}. Both are required.`,
    ],
    [
      '✗ DON\'T',
      'Enter a manager whose Hierarchy is not exactly one level above. ' +
      `Example: ${leafConfig.roleCode} MUST report to ${parentOfLeaf?.roleCode ?? 'the next level up'}, not skip a level.`,
    ],
    [
      '✗ DON\'T',
      'Move an employee who still has outlets or sub-reports. Clean the position first.',
    ],
    [
      '✗ DON\'T',
      'Delete or rename the column headers in the "Employee Upload" sheet. ' +
      'If headers are missing or wrong, the entire upload is rejected.',
    ],
    ['', ''],

    // ── Common mistakes ────────────────────────────────────────────────────
    ['━━━  COMMON MISTAKES  ━━━', ''],
    ['Mistake', 'How to fix it'],
    [
      '"Not a valid hierarchy level" error',
      `Check your Hierarchy column. Valid values: ${rolesStr}. No other text is accepted.`,
    ],
    [
      '"Manager not found" error',
      'The Reporting Manager Employee ID does not exist in the system and is not in this file. ' +
      'Check the ID for typos, or add the manager as a row in the same upload.',
    ],
    [
      '"Must report to [X]" error',
      'Your Reporting Manager is the wrong level. Check that the manager is exactly one level above ' +
      'in the hierarchy. Use the Column Reference above for the required level.',
    ],
    [
      '"Reporting Manager Hierarchy says X but employee is actually Y" error',
      'The two manager columns are inconsistent. The Hierarchy column must match the ' +
      'actual role of the employee ID in the other column.',
    ],
    [
      '"Has outlets assigned" or "Has sub-reports" error',
      'You are trying to change the hierarchy of an active position. ' +
      'Reassign outlets and create replacements for sub-reports first, then re-upload.',
    ],
    ['', ''],
    [
      'For step-by-step scenario guides, download the Operations Guide from the portal.',
      '',
    ],
  ];

  return {
    headers: REQUIRED_HEADERS,
    exampleRows: [
      // NSM row — no manager
      [rootConfig.roleCode, `${rootConfig.roleCode}-001`, 'Anand Rao', '9900000001', '', ''],
      // Middle level — parent of leaf
      [
        parentOfLeaf?.roleCode ?? '',
        `${parentOfLeaf?.roleCode ?? 'SO'}-MUM1`,
        'Rajesh Kumar', '9900000028',
        rootConfig.roleCode,
        `${rootConfig.roleCode}-001`,
      ],
      // Leaf with full details
      [
        leafConfig.roleCode, `${leafConfig.roleCode}-P001`,
        'Anil Sharma', '9900000041',
        parentOfLeaf?.roleCode ?? '',
        `${parentOfLeaf?.roleCode ?? 'SO'}-MUM1`,
      ],
      // Placeholder — blank name and phone
      [
        leafConfig.roleCode, `${leafConfig.roleCode}-P002`,
        '', '',
        parentOfLeaf?.roleCode ?? '',
        `${parentOfLeaf?.roleCode ?? 'SO'}-MUM1`,
      ],
    ],
    dosAndDontsRows,
  };
}

// ─── HTML guide document ──────────────────────────────────────────────────────

export function generateGuideHtml(config: TenantHierarchyLevel[]): string {
  const roles      = config.map(l => l.roleCode);
  const leafCode   = config.find(l => l.isLeaf)?.roleCode  ?? roles[0];
  const rootCode   = config.find(l => l.isRoot)?.roleCode  ?? roles[roles.length - 1];
  const levelStr   = roles.join(' < ');
  const parentCode = config.find(l => l.level === 2)?.roleCode ?? '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Employee Hierarchy — Operations Guide</title>
<style>
  body{font-family:Arial,sans-serif;max-width:900px;margin:40px auto;padding:0 24px;color:#1a1a2e;line-height:1.7}
  h1{color:#c0392b;border-bottom:3px solid #c0392b;padding-bottom:8px}
  h2{color:#1a1a2e;margin-top:36px;border-left:4px solid #c0392b;padding-left:10px}
  h3{color:#444;margin-top:24px}
  table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14px}
  th{background:#1a1a2e;color:#fff;padding:10px 14px;text-align:left}
  td{border:1px solid #ddd;padding:9px 14px;vertical-align:top}
  tr:nth-child(even) td{background:#f9f9f9}
  .box{padding:12px 18px;margin:14px 0;border-radius:4px}
  .ok   {background:#d4edda;border-left:4px solid #28a745}
  .warn {background:#fff3cd;border-left:4px solid #ffc107}
  .err  {background:#f8d7da;border-left:4px solid #dc3545}
  code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-family:monospace;font-size:13px}
  ol li,ul li{margin-bottom:6px}
  @media print{.no-print{display:none}}
</style>
</head>
<body>
<h1>Employee Hierarchy Management — Operations Guide</h1>
<p class="no-print"><em>Print this page (Ctrl+P / Cmd+P) to save as PDF.</em></p>

<h2>1. Hierarchy Structure</h2>
<p><strong>Level order (lowest → highest): ${levelStr}</strong></p>
<ul>
  <li><strong>${leafCode}</strong> — Field level. Directly tagged to outlets.</li>
${config.filter(l => !l.isLeaf && !l.isRoot)
        .map(l => `  <li><strong>${l.roleCode}</strong> — Manages the team below them.</li>`)
        .join('\n')}
  <li><strong>${rootCode}</strong> — Top of the hierarchy. No reporting manager.</li>
</ul>

<h2>2. Upload Column Reference</h2>
<table>
  <tr><th>Column</th><th>Required?</th><th>Rules</th></tr>
  <tr><td>Hierarchy</td><td>Yes</td><td>One of: ${roles.join(', ')}. Case-insensitive.</td></tr>
  <tr><td>Employee ID</td><td>Yes</td><td>Unique position code (e.g. Pune101). Letters, digits, hyphens only. Identifies the territory, not the person.</td></tr>
  <tr><td>Employee Name</td><td>No</td><td>Leave blank for a PLACEHOLDER position.</td></tr>
  <tr><td>Employee Phone Number</td><td>No</td><td>Exactly 10 digits (no +91) or blank. Unique system-wide.</td></tr>
  <tr><td>Reporting Manager Hierarchy</td><td>Yes (except ${rootCode})</td><td>Must be exactly one level above the employee. Cross-checked against manager's actual role.</td></tr>
  <tr><td>Reporting Manager Employee ID</td><td>Yes (except ${rootCode})</td><td>Must exist in the system or appear in this upload file.</td></tr>
</table>

<h2>3. Scenarios Step-by-Step</h2>

<h3>A. Adding a New Employee</h3>
<ol>
  <li>Download the template from the Hierarchy page.</li>
  <li>Fill all 6 columns. Leave Name and Phone blank for a placeholder.</li>
  <li>Upload → review validation results → confirm.</li>
</ol>

<h3>B. Editing Name or Phone Only</h3>
<div class="box ok">Always safe — never triggers a hierarchy recalculation.</div>
<ol>
  <li>Use the same Employee ID, same Hierarchy, same Reporting Manager.</li>
  <li>Update the Name and/or Phone Number columns.</li>
  <li>Upload and confirm. Status changes from PLACEHOLDER → ACTIVE when name+phone are added.</li>
</ol>

<h3>C. Filling a Vacant (Placeholder) Position</h3>
<ol>
  <li>Use the existing Employee ID (it already exists as PLACEHOLDER).</li>
  <li>Add the new person's name and phone number.</li>
  <li>Keep Hierarchy and Reporting Manager unchanged.</li>
  <li>Upload and confirm. No outlets or sub-reports change.</li>
</ol>

<h3>D. Moving an Employee to a Different Manager</h3>
<div class="box warn"><strong>Rule:</strong> Employee must have <em>no outlets assigned</em> and <em>no sub-reports</em> before they can be moved.</div>
<ol>
  <li>Ensure position is clean — reassign outlets and replace sub-reports first.</li>
  <li>Upload the row with the same Employee ID and Hierarchy, but the new Reporting Manager ID.</li>
  <li>All ${leafCode}s beneath them will have their hierarchy paths recalculated automatically — you do NOT upload them separately.</li>
</ol>

<h3>E. Promoting an Employee (Role Change, e.g. ${parentCode} → ASM)</h3>
<div class="box err"><strong>Rule:</strong> Cannot change role while the position has outlets or sub-reports. Use the Replacement-First flow.</div>
<ol>
  <li>Create a replacement at the old role level (new Employee ID, or activate a placeholder).</li>
  <li>Reassign all outlets and sub-reports to the replacement.</li>
  <li>Now upload the original Employee ID with the new Hierarchy and correct new Reporting Manager.</li>
</ol>

<h3>F. Employee Resigned — Keeping Position Intact</h3>
<div class="box warn"><strong>Do NOT delete the Employee ID.</strong> Deleting a position breaks outlet assignments.</div>
<ol>
  <li>Upload the same Employee ID with blank Name and blank Phone.</li>
  <li>Position becomes PLACEHOLDER — hierarchy and outlet assignments are preserved.</li>
  <li>When a replacement is found, update the Name and Phone against the same Employee ID.</li>
</ol>

<h3>G. Entire Sub-team Moves to a New Manager</h3>
<ol>
  <li>Upload only the top-of-sub-team's row with the new Reporting Manager ID.</li>
  <li>The system recalculates ALL descendant hierarchy paths automatically.</li>
  <li>You do not need to upload rows for every subordinate.</li>
</ol>

<h3>H. New Position in a Growing Territory</h3>
<ol>
  <li>Create a new Employee ID (e.g. Pune201 for a new ${leafCode} territory).</li>
  <li>Set the appropriate manager in the Reporting Manager columns.</li>
  <li>Upload. The new position appears immediately in the hierarchy.</li>
</ol>

<h2>4. Validation Rules Quick Reference</h2>
<table>
  <tr><th>Rule</th><th>What happens if violated</th></tr>
  <tr><td>Employee ID must be unique in the upload file</td><td>Row error — duplicate row is rejected</td></tr>
  <tr><td>Employee ID: only letters, digits, hyphens</td><td>Row error</td></tr>
  <tr><td>Phone must be 10 digits or blank</td><td>Row error</td></tr>
  <tr><td>Phone must be unique system-wide</td><td>Row error — shows which employee already has it</td></tr>
  <tr><td>Hierarchy must be a valid level</td><td>Row error — lists valid options</td></tr>
  <tr><td>Reporting manager must exist</td><td>Row error</td></tr>
  <tr><td>Manager must be exactly one level above</td><td>Row error — shows expected level</td></tr>
  <tr><td>Manager Hierarchy column must match manager's actual role</td><td>Row error — cross-checked automatically</td></tr>
  <tr><td>${rootCode} must not have manager columns</td><td>Row error</td></tr>
  <tr><td>Non-${rootCode} must have manager columns</td><td>Row error</td></tr>
  <tr><td>Employee with outlets cannot change hierarchy</td><td>Row error — reassign outlets first</td></tr>
  <tr><td>Employee with sub-reports cannot change hierarchy</td><td>Row error — create replacement first</td></tr>
  <tr><td>No circular reporting chains</td><td>Row error — loop detected automatically</td></tr>
</table>

<h2>5. Two-Pass Validation Explained</h2>
<ol>
  <li><strong>Pass 1 — Column Headers:</strong> If any required column is missing, the entire file is rejected immediately. Fix headers and re-upload.</li>
  <li><strong>Pass 2 — Row Data:</strong> Every row is checked. All errors are shown at once so you can fix everything in one round.</li>
</ol>
<div class="box ok">Tip: The template provided by the system always has the correct headers. Start from the template to avoid Pass 1 failures.</div>

<h2>6. Frequently Asked Edge Cases</h2>
<table>
  <tr><th>Scenario</th><th>What the system does</th></tr>
  <tr><td>Same Employee ID with same role + same manager</td><td>UPDATE_INFO — only name/phone change</td></tr>
  <tr><td>Same Employee ID with different manager</td><td>UPDATE_HIERARCHY — subject to outlet/sub-report checks</td></tr>
  <tr><td>New Employee ID not in system</td><td>CREATE</td></tr>
  <tr><td>Manager defined below current row in same file</td><td>Valid — system reads the whole file first</td></tr>
  <tr><td>Duplicate phone number in same upload</td><td>Error on the second row that uses the phone</td></tr>
  <tr><td>Blank row in the Excel file</td><td>Silently skipped</td></tr>
  <tr><td>A → B → A reporting loop</td><td>Circular dependency error</td></tr>
</table>

<p style="margin-top:48px;color:#999;font-size:12px;border-top:1px solid #eee;padding-top:16px">
  Gifsy Platform · Employee Hierarchy Management Guide · Generated ${new Date().toLocaleDateString('en-IN')}
</p>
</body>
</html>`;
}
