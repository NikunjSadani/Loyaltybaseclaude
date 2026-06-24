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
  // The localStorage role override is a TEST/dev aid ONLY — it is IGNORED in a
  // production build, so a real user cannot spoof their FE sales role by setting
  // localStorage. (The backend always enforces the real role from the JWT; the
  // override only ever changed FE display.) In dev/test it still drives the
  // role-simulation specs.
  if (process.env.NODE_ENV !== 'production') {
    const stored = localStorage.getItem(STORAGE_KEY) as SalesRole | null;
    if (stored) {
      // migrate legacy codes
      if (stored === ('ISR' as string))        return 'XSR';
      if (stored === ('ZM' as string))         return 'ZNM';
      if (stored === ('NM' as string))         return 'NSM';
      if (stored === ('STATE_HEAD' as string)) return 'RSM';
      if (stored === ('HO' as string))         return 'NSM';
      return stored;
    }
  }
  // Reflect the REAL logged-in user's role from the JWT.
  return roleFromBackend(getStoredUser()?.role);
}

export function setRole(role: SalesRole): void {
  localStorage.setItem(STORAGE_KEY, role);
}

export function hasTeamView(role: SalesRole): boolean {
  return HAS_TEAM.includes(role);
}
