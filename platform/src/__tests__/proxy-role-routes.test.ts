/**
 * Regression guard for the edge-proxy role gate (proxy.ts ROLE_ROUTES).
 *
 * The proxy 307-redirects any authenticated user whose JWT `role` is not in the
 * allow-list for the path prefix they hit. If a list drifts from the backend
 * UserRole enum, EVERY login for that portal bounces to /auth/login server-side
 * — which is exactly what happened to the whole sales team (the list held legacy
 * codes HO/STATE_HEAD/ASM/SO/XSR/… while real sales JWTs carry SALES_*).
 *
 * These tests lock every ROLE_ROUTES value to canonical UserRole codes so the
 * drift can never silently reappear.
 *
 * Run: npx vitest run src/__tests__/proxy-role-routes.test.ts
 */
import { describe, it, expect } from 'vitest';
import { ROLE_ROUTES } from '@/proxy';

// Canonical backend roles — mirror api/prisma/schema.prisma `enum UserRole`.
const USER_ROLE = new Set([
  'GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER',
  'SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR',
  'SSS', 'WHOLESALER', 'SUB_STOCKIST',
]);

const SALES_ROLES = ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'];

describe('proxy ROLE_ROUTES — canonical role codes only', () => {
  it('every role in every route list is a real UserRole enum value (no legacy/typo codes)', () => {
    const offenders: Array<{ prefix: string; role: string }> = [];
    for (const [prefix, roles] of Object.entries(ROLE_ROUTES)) {
      for (const role of roles) {
        if (!USER_ROLE.has(role)) offenders.push({ prefix, role });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('/sales admits exactly the SALES_* roles (the set that was bouncing)', () => {
    expect([...ROLE_ROUTES['/sales']].sort()).toEqual([...SALES_ROLES].sort());
  });

  it('/sales admits SALES_ISR and SALES_SO (the two phones the owner tested)', () => {
    expect(ROLE_ROUTES['/sales']).toContain('SALES_ISR');
    expect(ROLE_ROUTES['/sales']).toContain('SALES_SO');
  });

  it('/admin and /partner lists remain canonical (regression-proof the working portals too)', () => {
    expect(ROLE_ROUTES['/admin']).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER']);
    expect(ROLE_ROUTES['/partner']).toEqual(['SSS', 'WHOLESALER', 'SUB_STOCKIST']);
  });
});
