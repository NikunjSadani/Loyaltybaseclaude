/// <reference types="vitest/globals" />
/**
 * TDD — Admin session + scheme access control
 *
 * A: canManageSchemes() — role-based access
 * B: getAdminSession() — reads stored role
 * C: multi-tenant: CLIENT_ADMIN cannot manage schemes for any tenant
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  canManageSchemes,
  getAdminSession,
  setDemoAdminRole,
  type AdminRole,
} from '@/lib/admin-session';

describe('A — canManageSchemes()', () => {
  it('A1: GIFSY_ADMIN can manage schemes', () => {
    expect(canManageSchemes('GIFSY_ADMIN')).toBe(true);
  });

  it('A2: CLIENT_ADMIN cannot manage schemes', () => {
    expect(canManageSchemes('CLIENT_ADMIN')).toBe(false);
  });

  it('A3: MIS_USER cannot manage schemes', () => {
    expect(canManageSchemes('MIS_USER')).toBe(false);
  });

  it('A4: null (unauthenticated) cannot manage schemes', () => {
    expect(canManageSchemes(null)).toBe(false);
  });

  it('A5: unknown role cannot manage schemes', () => {
    expect(canManageSchemes('SOME_RANDOM_ROLE' as AdminRole)).toBe(false);
  });
});

describe('B — getAdminSession()', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('B1: defaults to CLIENT_ADMIN when nothing stored', () => {
    const session = getAdminSession();
    expect(session.role).toBe('CLIENT_ADMIN');
  });

  it('B2: returns GIFSY_ADMIN when stored as such', () => {
    setDemoAdminRole('GIFSY_ADMIN');
    expect(getAdminSession().role).toBe('GIFSY_ADMIN');
  });

  it('B3: returns CLIENT_ADMIN when stored as such', () => {
    setDemoAdminRole('CLIENT_ADMIN');
    expect(getAdminSession().role).toBe('CLIENT_ADMIN');
  });

  it('B4: session includes canManageSchemes derived field', () => {
    setDemoAdminRole('GIFSY_ADMIN');
    expect(getAdminSession().canManageSchemes).toBe(true);

    setDemoAdminRole('CLIENT_ADMIN');
    expect(getAdminSession().canManageSchemes).toBe(false);
  });

  it('B5: session includes clientId (tenant scoping)', () => {
    const session = getAdminSession();
    expect(session).toHaveProperty('clientId');
    expect(typeof session.clientId).toBe('string');
  });
});

describe('C — multi-tenant: CLIENT_ADMIN is tenant-scoped', () => {
  it('C1: CLIENT_ADMIN for tenant A cannot manage schemes even for their own tenant', () => {
    expect(canManageSchemes('CLIENT_ADMIN')).toBe(false);
  });

  it('C2: GIFSY_ADMIN can manage schemes for any tenant (platform-wide)', () => {
    expect(canManageSchemes('GIFSY_ADMIN')).toBe(true);
  });
});
