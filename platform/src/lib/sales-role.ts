// XSR → SO → ASM → RSM → ZM → NM
export type SalesRole = 'XSR' | 'SO' | 'ASM' | 'RSM' | 'ZM' | 'NM';

export const ROLE_LABELS: Record<SalesRole, string> = {
  XSR: 'Executive Sales Representative',
  SO:  'Sales Officer',
  ASM: 'Area Sales Manager',
  RSM: 'Regional Sales Manager',
  ZM:  'Zonal Manager',
  NM:  'National Manager',
};

/** Short display name shown in chips/badges */
export const ROLE_SHORT: Record<SalesRole, string> = {
  XSR: 'XSR',
  SO:  'SO',
  ASM: 'ASM',
  RSM: 'RSM',
  ZM:  'ZM',
  NM:  'NM',
};

export const ROLE_NAMES: Record<SalesRole, string> = {
  XSR: 'Anil Sharma',
  SO:  'Rajesh Kumar',
  ASM: 'Priya Mehta',
  RSM: 'Suresh Nair',
  ZM:  'Vikram Singh',
  NM:  'Anand Rao',
};

export const ROLE_EMP_IDS: Record<SalesRole, string> = {
  XSR: 'EMP-2024-0041',
  SO:  'EMP-2023-0028',
  ASM: 'EMP-2019-0007',
  RSM: 'EMP-2016-0003',
  ZM:  'EMP-2012-0002',
  NM:  'EMP-2010-0001',
};

export const ROLE_TERRITORY: Record<SalesRole, string> = {
  XSR: 'Andheri Beat',
  SO:  'Mumbai West',
  ASM: 'Mumbai Zone',
  RSM: 'Maharashtra Region',
  ZM:  'West Zone',
  NM:  'Pan India',
};

/** Role immediately above in the hierarchy (for KYC approval routing) */
export const REPORTS_TO: Partial<Record<SalesRole, SalesRole>> = {
  XSR: 'SO',
  SO:  'ASM',
  ASM: 'RSM',
  RSM: 'ZM',
  ZM:  'NM',
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
  ZM:  '9900000002',
  NM:  '9900000001',
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
  // Fallback: NM always approves (NM cannot resign without a replacement)
  return 'NM';
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
    ZM:  'PENDING_RSM_APPROVAL', // treated same tier for now
    NM:  'PENDING_RSM_APPROVAL',
  };
  return map[approverRole] ?? 'PENDING_SO_APPROVAL';
}

// Roles that can see a team below them (all except XSR)
export const HAS_TEAM: SalesRole[] = ['SO', 'ASM', 'RSM', 'ZM', 'NM'];

const STORAGE_KEY = 'loyaltybase_sales_role';

export function getRole(): SalesRole {
  if (typeof window === 'undefined') return 'SO';
  const stored = localStorage.getItem(STORAGE_KEY) as SalesRole | null;
  // Migrate legacy 'ISR' → 'XSR', 'STATE_HEAD' → 'RSM', 'HO' → 'NM'
  if (stored === ('ISR' as string))        return 'XSR';
  if (stored === ('STATE_HEAD' as string)) return 'RSM';
  if (stored === ('HO' as string))         return 'NM';
  return stored ?? 'SO';
}

export function setRole(role: SalesRole): void {
  localStorage.setItem(STORAGE_KEY, role);
}

export function hasTeamView(role: SalesRole): boolean {
  return HAS_TEAM.includes(role);
}
