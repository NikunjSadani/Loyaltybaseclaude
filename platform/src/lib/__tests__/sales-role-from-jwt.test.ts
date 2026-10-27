/**
 * getRole() must reflect the REAL logged-in sales user's role (from the JWT stored
 * as `user`), not default everyone to 'SO'. The /sales UI (nav, team view, KYC
 * approver routing) keys off getRole(), so before this fix every sales user — XSR,
 * ASM, RSM, NSM — was presented as a Sales Officer.
 *
 * Run: npx vitest run src/lib/__tests__/sales-role-from-jwt.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getRole, setRole, roleFromBackend, canEnroll, ENROLL_ROLES } from '@/lib/sales-role';
import type { SalesRole } from '@/lib/sales-role';

function setUser(role: string) {
  localStorage.setItem('user', JSON.stringify({ id: 'u1', name: 'X', role, phone: '9' }));
}

describe('roleFromBackend — UserRole → FE sales taxonomy', () => {
  it('maps every canonical SALES_* role', () => {
    expect(roleFromBackend('SALES_HO')).toBe('NSM');
    expect(roleFromBackend('SALES_STATE_HEAD')).toBe('RSM');
    expect(roleFromBackend('SALES_ASM')).toBe('ASM');
    expect(roleFromBackend('SALES_SO')).toBe('SO');
    expect(roleFromBackend('SALES_ISR')).toBe('XSR');
  });
  it('falls back to SO for unknown / non-sales / nullish roles', () => {
    expect(roleFromBackend('CLIENT_ADMIN')).toBe('SO');
    expect(roleFromBackend(undefined)).toBe('SO');
    expect(roleFromBackend(null)).toBe('SO');
  });
});

describe('getRole — derives from the JWT user when no demo override', () => {
  beforeEach(() => localStorage.clear());

  it('an ISR login is presented as XSR (was SO before the fix)', () => {
    setUser('SALES_ISR');
    expect(getRole()).toBe('XSR');
  });

  it('an ASM login is presented as ASM (was SO before the fix)', () => {
    setUser('SALES_ASM');
    expect(getRole()).toBe('ASM');
  });

  it('an NSM (HO) login is presented as NSM', () => {
    setUser('SALES_HO');
    expect(getRole()).toBe('NSM');
  });

  it('no user stored → SO (safe default preserved)', () => {
    expect(getRole()).toBe('SO');
  });

  it('an explicit demo-switcher override still wins over the JWT role', () => {
    setUser('SALES_ISR');     // real role = XSR
    setRole('RSM');           // demo override
    expect(getRole()).toBe('RSM');
  });

  it('legacy stored code is still migrated when set as an override', () => {
    localStorage.setItem('loyaltybase_sales_role', 'STATE_HEAD');
    expect(getRole()).toBe('RSM');
  });
});

describe('canEnroll — roles that can INITIATE a KYC enrollment', () => {
  it('the two field reps can enroll (any tenant)', () => {
    expect(canEnroll('XSR')).toBe(true);
    expect(canEnroll('SO')).toBe(true);
    expect(canEnroll('XSR', 'bajaj')).toBe(true);
    expect(canEnroll('SO', 'bajaj')).toBe(true);
  });

  it('ASM can enroll by default (Deoleo, 2026-07-01) but NOT for Bajaj', () => {
    expect(canEnroll('ASM')).toBe(true);           // platform default (no slug)
    expect(canEnroll('ASM', 'deoleo')).toBe(true); // other tenant unchanged
    expect(canEnroll('ASM', 'bajaj')).toBe(false); // Bajaj: ASM is approver-only (2026-10-27)
  });

  it('managers above ASM cannot enroll (any tenant)', () => {
    for (const r of ['RSM', 'ZNM', 'NSM'] as SalesRole[]) {
      expect(canEnroll(r)).toBe(false);
      expect(canEnroll(r, 'bajaj')).toBe(false);
    }
  });

  it('platform default (no slug) = XSR/SO/ASM; Bajaj = XSR/SO only', () => {
    const roles: SalesRole[] = ['XSR', 'SO', 'ASM', 'RSM', 'ZNM', 'NSM'];
    expect(roles.filter((r) => canEnroll(r))).toEqual(['XSR', 'SO', 'ASM']);
    expect(roles.filter((r) => canEnroll(r, 'bajaj'))).toEqual(['XSR', 'SO']);
    expect(ENROLL_ROLES).toEqual(['XSR', 'SO', 'ASM']);
  });
});
