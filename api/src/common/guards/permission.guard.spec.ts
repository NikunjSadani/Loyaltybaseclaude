// RBAC Option-X — PermissionGuard (flag-gated enforcement + GIFSY_STAFF resolution).
// Run: npx jest src/common/guards/permission.guard.spec.ts

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from './permission.guard';
import type { TenantService } from '../../tenant/tenant.service';
import type { GifsyRoleService } from '../rbac/gifsy-role.service';
import type { Permission } from '../rbac/permissions';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReflector(permission: Permission | undefined): Reflector {
  return { getAllAndOverride: jest.fn().mockReturnValue(permission) } as unknown as Reflector;
}

function makeTenant(enabled: boolean): TenantService {
  return { isFeatureEnabled: jest.fn().mockResolvedValue(enabled) } as unknown as TenantService;
}

function makeGifsyRoles(perms: Permission[]): GifsyRoleService {
  return {
    getPermissions: jest.fn().mockResolvedValue(new Set<Permission>(perms)),
  } as unknown as GifsyRoleService;
}

function makeContext(
  user: { role?: string; clientId?: string; gifsyRoleId?: string | null } | null,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

const STAFF = { role: 'GIFSY_STAFF', clientId: 'gifsy', gifsyRoleId: 'role-1' };

describe('PermissionGuard', () => {
  const ORIGINAL_ENV = process.env.RBAC_ENFORCEMENT;
  afterEach(() => {
    process.env.RBAC_ENFORCEMENT = ORIGINAL_ENV;
    jest.clearAllMocks();
  });

  // ── A. No-op paths (the live default) ─────────────────────────────────────
  describe('A – no-op unless enforcement is fully on', () => {
    it('A1: route without @RequirePermission → allow', async () => {
      const guard = new PermissionGuard(makeReflector(undefined), makeTenant(true), makeGifsyRoles([]));
      await expect(guard.canActivate(makeContext(STAFF))).resolves.toBe(true);
    });

    it('A2: RBAC_ENFORCEMENT env off (default) → allow even for staff lacking the perm', async () => {
      delete process.env.RBAC_ENFORCEMENT;
      const guard = new PermissionGuard(makeReflector('kyc:read'), makeTenant(true), makeGifsyRoles([]));
      await expect(guard.canActivate(makeContext(STAFF))).resolves.toBe(true);
    });

    it('A3: env on but tenant flag off → allow (fail-open)', async () => {
      process.env.RBAC_ENFORCEMENT = 'true';
      const guard = new PermissionGuard(makeReflector('kyc:read'), makeTenant(false), makeGifsyRoles([]));
      await expect(guard.canActivate(makeContext(STAFF))).resolves.toBe(true);
    });
  });

  // ── B. Enforcement ON ──────────────────────────────────────────────────────
  describe('B – enforcement fully on', () => {
    beforeEach(() => {
      process.env.RBAC_ENFORCEMENT = 'true';
    });

    it('B1: missing user → Unauthorized', async () => {
      const guard = new PermissionGuard(makeReflector('kyc:read'), makeTenant(true), makeGifsyRoles([]));
      await expect(guard.canActivate(makeContext(null))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    // GIFSY_STAFF — resolved from the assigned GifsyRole
    it('B2: GIFSY_STAFF whose role HAS the permission → allow', async () => {
      const roles = makeGifsyRoles(['kyc:read']);
      const guard = new PermissionGuard(makeReflector('kyc:read'), makeTenant(true), roles);
      await expect(guard.canActivate(makeContext(STAFF))).resolves.toBe(true);
      expect(roles.getPermissions).toHaveBeenCalledWith('role-1');
    });

    it('B3: GIFSY_STAFF whose role LACKS the permission → Forbidden', async () => {
      const guard = new PermissionGuard(
        makeReflector('kyc:approve'),
        makeTenant(true),
        makeGifsyRoles(['kyc:read']),
      );
      await expect(guard.canActivate(makeContext(STAFF))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('B4: GIFSY_STAFF with null gifsyRoleId → Forbidden (fail-closed)', async () => {
      const roles = makeGifsyRoles([]); // resolver returns empty for a null id
      const guard = new PermissionGuard(makeReflector('kyc:read'), makeTenant(true), roles);
      await expect(
        guard.canActivate(makeContext({ role: 'GIFSY_STAFF', clientId: 'gifsy', gifsyRoleId: null })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('B5: a role holding a RESERVED key resolves it (grant honored at the fine gate)', async () => {
      // Confirms resolution honors the grant; the coarse @Roles floor (not tested
      // here — no route wiring in P0) is what actually hard-blocks staff on reserved routes.
      const guard = new PermissionGuard(
        makeReflector('wallet:adjust'),
        makeTenant(true),
        makeGifsyRoles(['wallet:adjust']),
      );
      await expect(guard.canActivate(makeContext(STAFF))).resolves.toBe(true);
    });

    // Other roles — unchanged static can() path
    it('B6: GIFSY_ADMIN has ALL permissions (never touches the resolver)', async () => {
      const roles = makeGifsyRoles([]);
      const guard = new PermissionGuard(makeReflector('wallet:adjust'), makeTenant(true), roles);
      await expect(
        guard.canActivate(makeContext({ role: 'GIFSY_ADMIN', clientId: 'gifsy' })),
      ).resolves.toBe(true);
      expect(roles.getPermissions).not.toHaveBeenCalled();
    });

    it('B7: CLIENT_ADMIN allowed on a perm it holds, denied on one it lacks', async () => {
      const g1 = new PermissionGuard(makeReflector('kyc:read'), makeTenant(true), makeGifsyRoles([]));
      await expect(
        g1.canActivate(makeContext({ role: 'CLIENT_ADMIN', clientId: 'deoleo' })),
      ).resolves.toBe(true);

      // tenancy:write is GIFSY-operated → CLIENT_ADMIN does NOT have it
      const g2 = new PermissionGuard(makeReflector('tenancy:write'), makeTenant(true), makeGifsyRoles([]));
      await expect(
        g2.canActivate(makeContext({ role: 'CLIENT_ADMIN', clientId: 'deoleo' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
