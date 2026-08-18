// TDD: RolesGuard
// Tests written BEFORE implementation.
// Run: npx jest src/common/guards/roles.guard.spec.ts

import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import type { ExecutionContext } from '@nestjs/common';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReflector(roles: string[] | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn().mockReturnValue(roles),
  } as unknown as Reflector;
}

// Key-aware reflector for the GIFSY_STAFF branch (which reads BOTH ROLES_KEY and PERMISSION_KEY).
function makeReflector2(roles: string[] | undefined, permission: string | undefined): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) =>
      key === PERMISSION_KEY ? permission : roles,
    ),
  } as unknown as Reflector;
}

function makeContext(userRole: string | null): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: userRole ? { role: userRole } : null }),
    }),
    getHandler: () => ({}),
    getClass:   () => ({}),
  } as unknown as ExecutionContext;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('RolesGuard', () => {
  // ── A. No role requirement ────────────────────────────────────────────────

  describe('A – no roles required on route', () => {
    it('A1: allows any authenticated user when roles array is empty', () => {
      const guard = new RolesGuard(makeReflector([]));
      expect(guard.canActivate(makeContext('SALES_SO'))).toBe(true);
    });

    it('A2: allows when roles metadata is undefined', () => {
      const guard = new RolesGuard(makeReflector(undefined));
      expect(guard.canActivate(makeContext('RETAILER'))).toBe(true);
    });
  });

  // ── B. GIFSY_ADMIN superpower ─────────────────────────────────────────────

  describe('B – GIFSY_ADMIN has universal access', () => {
    it('B1: passes a CLIENT_ADMIN-only route', () => {
      const guard = new RolesGuard(makeReflector(['CLIENT_ADMIN']));
      expect(guard.canActivate(makeContext('GIFSY_ADMIN'))).toBe(true);
    });

    it('B2: passes a SALES_ASM-only route', () => {
      const guard = new RolesGuard(makeReflector(['SALES_ASM']));
      expect(guard.canActivate(makeContext('GIFSY_ADMIN'))).toBe(true);
    });

    it('B3: passes a route that lists only lower-tier roles', () => {
      const guard = new RolesGuard(makeReflector(['SALES_SO', 'SALES_ISR']));
      expect(guard.canActivate(makeContext('GIFSY_ADMIN'))).toBe(true);
    });

    it('B4: passes a GIFSY_ADMIN-only route (trivial, own role)', () => {
      const guard = new RolesGuard(makeReflector(['GIFSY_ADMIN']));
      expect(guard.canActivate(makeContext('GIFSY_ADMIN'))).toBe(true);
    });
  });

  // ── C. Normal role enforcement ────────────────────────────────────────────

  describe('C – normal role enforcement for non-GIFSY roles', () => {
    it('C1: CLIENT_ADMIN passes a CLIENT_ADMIN route', () => {
      const guard = new RolesGuard(makeReflector(['CLIENT_ADMIN']));
      expect(guard.canActivate(makeContext('CLIENT_ADMIN'))).toBe(true);
    });

    it('C2: CLIENT_ADMIN is blocked on a GIFSY_ADMIN-only route', () => {
      const guard = new RolesGuard(makeReflector(['GIFSY_ADMIN']));
      expect(() => guard.canActivate(makeContext('CLIENT_ADMIN'))).toThrow(ForbiddenException);
    });

    it('C3: SALES_SO passes when route allows CLIENT_ADMIN or SALES_SO', () => {
      const guard = new RolesGuard(makeReflector(['CLIENT_ADMIN', 'SALES_SO']));
      expect(guard.canActivate(makeContext('SALES_SO'))).toBe(true);
    });

    it('C4: SALES_ISR is blocked when route requires CLIENT_ADMIN only', () => {
      const guard = new RolesGuard(makeReflector(['CLIENT_ADMIN']));
      expect(() => guard.canActivate(makeContext('SALES_ISR'))).toThrow(ForbiddenException);
    });

    it('C5: error message names the required roles and the actual role', () => {
      const guard = new RolesGuard(makeReflector(['GIFSY_ADMIN', 'CLIENT_ADMIN']));
      try {
        guard.canActivate(makeContext('SALES_SO'));
        fail('expected ForbiddenException');
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(ForbiddenException);
        const msg = (e as ForbiddenException).message;
        expect(msg).toContain('GIFSY_ADMIN');
        expect(msg).toContain('SALES_SO');
      }
    });
  });

  // ── D. Unauthenticated requests ───────────────────────────────────────────

  describe('D – unauthenticated / missing user', () => {
    it('D1: throws ForbiddenException when user is absent', () => {
      const guard = new RolesGuard(makeReflector(['CLIENT_ADMIN']));
      expect(() => guard.canActivate(makeContext(null))).toThrow(ForbiddenException);
    });

    it('D2: unauthenticated request also rejected on public-but-role-listed route', () => {
      const guard = new RolesGuard(makeReflector(['SALES_SO', 'RETAILER']));
      expect(() => guard.canActivate(makeContext(null))).toThrow(ForbiddenException);
    });
  });

  // ── E. GIFSY_STAFF defers the coarse floor to @RequirePermission (RBAC Option-X P2) ──
  describe('E – GIFSY_STAFF defers to @RequirePermission', () => {
    it('E1: admitted past an owner-only @Roles when the route has a (non-manage_roles) @RequirePermission', () => {
      // e.g. @Roles('GIFSY_ADMIN') + @RequirePermission('kyc:read') → staff passes the coarse
      // floor here; PermissionGuard then enforces the actual grant.
      const guard = new RolesGuard(makeReflector2(['GIFSY_ADMIN'], 'kyc:read'));
      expect(guard.canActivate(makeContext('GIFSY_STAFF'))).toBe(true);
    });

    it('E2: BLOCKED on staff/role administration (users:manage_roles) regardless of grant', () => {
      const guard = new RolesGuard(makeReflector2(['GIFSY_ADMIN'], 'users:manage_roles'));
      expect(() => guard.canActivate(makeContext('GIFSY_STAFF'))).toThrow(ForbiddenException);
    });

    it('E3: BLOCKED on a route with NO @RequirePermission (no fine gate to defer to)', () => {
      const guard = new RolesGuard(makeReflector2(['GIFSY_ADMIN'], undefined));
      expect(() => guard.canActivate(makeContext('GIFSY_STAFF'))).toThrow(ForbiddenException);
    });

    it('E4: a route with no @Roles stays open (unchanged) — PermissionGuard still gates it', () => {
      const guard = new RolesGuard(makeReflector2(undefined, 'kyc:read'));
      expect(guard.canActivate(makeContext('GIFSY_STAFF'))).toBe(true);
    });

    it('E5: an explicit @Roles listing GIFSY_STAFF admits it even with no @RequirePermission', () => {
      const guard = new RolesGuard(makeReflector2(['GIFSY_STAFF'], undefined));
      expect(guard.canActivate(makeContext('GIFSY_STAFF'))).toBe(true);
    });
  });
});
