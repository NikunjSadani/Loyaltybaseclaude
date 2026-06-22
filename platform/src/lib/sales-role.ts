import { getStoredUser } from '@/lib/auth-client';

// XSR → SO → ASM → RSM → ZNM → NSM
export type SalesRole = 'XSR' | 'SO' | 'ASM' | 'RSM' | 'ZNM' | 'NSM';

export const ROLE_LABELS: Record<SalesRole, string> = {
  XSR: 'Executive Sales Representative',
  SO:  'Sales Officer',
  ASM: 'Area Sales Manager',
  RSM: 'Regional Sales Manager',
  ZNM: 'Zonal National Manager',
  NSM: 'National Sales Manager',
};

/** Short display name shown in chips/badges */
export const ROLE_SHORT: Record<SalesRole, string> = {
  XSR: 'XSR',
  SO:  'SO',
  ASM: 'ASM',
  RSM: 'RSM',
  ZNM: 'ZNM',
  NSM: 'NSM',
};

export const ROLE_NAMES: Record<SalesRole, string> = {
  XSR: 'Anil Sharma',
  SO:  'Rajesh Kumar',
  ASM: 'Priya Mehta',
  RSM: 'Suresh Nair',
  ZNM: 'Vikram Singh',
  NSM: 'Anand Rao',
};

export const ROLE_EMP_IDS: Record<SalesRole, string> = {
  XSR: 'EMP-2024-0041',
  SO:  'EMP-2023-0028',
  ASM: 'EMP-2019-0007',
  RSM: 'EMP-2016-0003',
  ZNM: 'EMP-2012-0002',
  NSM: 'EMP-2010-0001',
};

export const ROLE_TERRITORY: Record<SalesRole, string> = {
  XSR: 'Andheri Beat',
  SO:  'Mumbai West',
  ASM: 'Mumbai Zone',
  RSM: 'Maharashtra Region',
  ZNM: 'West Zone',
  NSM: 'Pan India',
};

/** Role immediately above in the hierarchy (for KYC approval routing) */
export const REPORTS_TO: Partial<Record<SalesRole, SalesRole>> = {
  XSR: 'SO',
  SO:  'ASM',
  ASM: 'RSM',
  RSM: 'ZNM',
  ZNM: 'NSM',
};

/** Phone numbers for each role in the logged-in user's chain.
 *  A blank string ('') signals that the person has resigned.
 *  In production this would come from the backend; here we use a module-level
 *  constant so it can be overridden in tests via the second argument of resolveApprover.
 */
export type RolePhones = Record<SalesRole, string>;

export const ROLE_PHONES: RolePhones = {
  XSR: '9900000041',
  SO:  '9900000028',   // set to '' to simulate a resigned SO
  ASM: '9900000007',
  RSM: '9900000003',
  ZNM: '9900000002',
  NSM: '9900000001',
};

/**
 * Walk up the REPORTS_TO chain starting from the immediate superior of
 * `submitterRole`. Skip any role whose phone is blank (resigned).
 * Returns the first non-resigned approver role.
 *
 * @param submitterRole - the role of the person who filed the KYC
 * @param phones        - phone table to check (defaults to ROLE_PHONES)
 */
export function resolveApprover(
  submitterRole: SalesRole,
  phones: RolePhones = ROLE_PHONES,
): SalesRole {
  let current: SalesRole | undefined = REPORTS_TO[submitterRole];
  while (current) {
    if (phones[current] !== '') return current;
    current = REPORTS_TO[current];
  }
  // Fallback: NSM always approves (NSM cannot resign without a replacement)
  return 'NSM';
}

/**
 * Map a resolved approver role → the KYCStatus value that means
 * "waiting for this person to approve."
 */
export function statusForApprover(approverRole: SalesRole): string {
  const map: Partial<Record<SalesRole, string>> = {
    SO:  'PENDING_SO_APPROVAL',
    ASM: 'PENDING_ASM_APPROVAL',
    RSM: 'PENDING_RSM_APPROVAL',
    ZNM: 'PENDING_RSM_APPROVAL', // treated same tier for now
    NSM: 'PENDING_RSM_APPROVAL',
  };
  return map[approverRole] ?? 'PENDING_SO_APPROVAL';
}

// Roles that can see a team below them (all except XSR)
export const HAS_TEAM: SalesRole[] = ['SO', 'ASM', 'RSM', 'ZNM', 'NSM'];

const STORAGE_KEY = 'loyaltybase_sales_role';

/**
 * Map a backend UserRole (the JWT `role`, e.g. `SALES_ISR`) to the FE sales taxonomy
 * used across the /sales UI. Inverse of api `mapRoleCodeToUserRole` (RSM/ZNM both
 * collapse to SALES_STATE_HEAD → we surface RSM). Unknown/non-sales → 'SO'.
 */
export function roleFromBackend(backendRole?: string | null): SalesRole {
  switch (backendRole) {
    case 'SALES_HO':         return 'NSM';
    case 'SALES_STATE_HEAD': return 'RSM';
    case 'SALES_ASM':        return 'ASM';
    case 'SALES_SO':         return 'SO';
    case 'SALES_ISR':        return 'XSR';
    default:                 return 'SO';
  }
}

export function getRole(): SalesRole {
  if (typeof window === 'undefined') return 'SO';
  const stored = localStorage.getItem(STORAGE_KEY) as SalesRole | null;
  // An explicit demo/role-switcher override wins (test aid) — migrate legacy codes.
  if (stored) {
    if (stored === ('ISR' as string))        return 'XSR';
    if (stored === ('ZM' as string))         return 'ZNM';
    if (stored === ('NM' as string))         return 'NSM';
    if (stored === ('STATE_HEAD' as string)) return 'RSM';
    if (stored === ('HO' as string))         return 'NSM';
    return stored;
  }
  // No override → reflect the REAL logged-in user's role from the JWT. Previously this
  // returned 'SO' unconditionally, so every sales user appeared as a Sales Officer.
  return roleFromBackend(getStoredUser()?.role);
}

export function setRole(role: SalesRole): void {
  localStorage.setItem(STORAGE_KEY, role);
}

export function hasTeamView(role: SalesRole): boolean {
  return HAS_TEAM.includes(role);
}
