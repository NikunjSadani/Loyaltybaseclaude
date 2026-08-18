// RBAC Option-X — PermissionGuard.
// GIFSY_STAFF is ALWAYS enforced (fail-closed), independent of the RBAC_ENFORCEMENT flags;
// LEGACY roles stay flag-gated (env + per-tenant); @Public routes are never permission-gated.
// Run: npx jest src/common/guards/permission.guard.spec.ts

import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGuard } from './permission.guard';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import type { TenantService } from '../../tenant/tenant.service';
import type { GifsyRoleService } from '../rbac/gifsy-role.service';
import type { Permission } from '../rbac/permissions';

// ── Helpers ──────────────────────────────────────────────────────────────────

// The guard reads TWO metadata keys: PERMISSION_KEY (the required permission) and 'isPublic'.
// The mock must answer each key correctly (a single mockReturnValue would leak the permission
// string into the isPublic check and short-circuit every test).
function makeReflector(permission: Permission | undefined, isPublic = false): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) =>
      key === 'isPublic' ? isPublic : permission,
    ),
  } as unknown as Reflector;
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

  // ── A. Universal short-circuits ──────────────────────────────────────────────
  describe('A – short-circuits', () => {
    it('A1: route without @RequirePermission → allow', async () => {
      const guard = new PermissionGuard(makeReflector(undefined), makeTenant(true), makeGifsyRoles([]));
      await expect(guard.canActivate(makeContext(STAFF))).resolves.toBe(true);
    });

    it('A2: @Public route → allow even for a staff lacking the perm (never permission-gated)', async () => {
      delete process.env.RBAC_ENFORCEMENT;
      const guard = new PermissionGuard(makeReflector('kyc:read', true), makeTenant(true), makeGifsyRoles([]));
      await expect(guard.canActivate(makeContext(STAFF))).resolves.toBe(true);
    });
  });

  // ── B. GIFSY_STAFF is ALWAYS enforced (flag-independent) ─────────────────────
  describe('B – GIFSY_STAFF always-on (fail-closed)', () => {
    it('B1: env OFF + staff LACKS perm → Forbidden (not a no-op for staff)', async () => {
      delete process.env.RBAC_ENFORCEMENT;
      const guard = new PermissionGuard(makeReflector('kyc:approve'), makeTenant(false), makeGifsyRoles(['kyc:read']));
      await expect(guard.canActivate(makeContext(STAFF))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('B2: env OFF + staff HAS perm → allow', async () => {
      delete process.env.RBAC_ENFORCEMENT;
      const roles = makeGifsyRoles(['kyc:read']);
      const guard = new PermissionGuard(makeReflector('kyc:read'), makeTenant(false), roles);
      await expect(guard.canActivate(makeContext(STAFF))).resolves.toBe(true);
      expect(roles.getPermissions).toHaveBeenCalledWith('role-1');
    });

    it('B3: env ON + tenant flag OFF + staff lacks perm → still Forbidden (independent of per-tenant flag)', async () => {
      process.env.RBAC_ENFORCEMENT = 'true';
      const guard = new PermissionGuard(makeReflector('kyc:approve'), makeTenant(false), makeGifsyRoles(['kyc:read']));
      await expect(guard.canActivate(makeContext(STAFF))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('B4: staff with null gifsyRoleId → Forbidden (fail-closed)', async () => {
      delete process.env.RBAC_ENFORCEMENT;
      const guard = new PermissionGuard(makeReflector('kyc:read'), makeTenant(true), makeGifsyRoles([]));
      await expect(
        guard.canActivate(makeContext({ role: 'GIFSY_STAFF', clientId: 'gifsy', gifsyRoleId: null })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('B5: a knowingly-granted RESERVED key is honored at the fine gate (Lock-2 dropped)', async () => {
      delete process.env.RBAC_ENFORCEMENT;
      const guard = new PermissionGuard(makeReflector('wallet:adjust'), makeTenant(false), makeGifsyRoles(['wallet:adjust']));
      await expect(guard.canActivate(makeContext(STAFF))).resolves.toBe(true);
    });
  });

  // ── C. LEGACY roles stay flag-gated ──────────────────────────────────────────
  describe('C – legacy roles flag-gated', () => {
    it('C1: env OFF → allow even for a legacy role lacking the perm (no-op default)', async () => {
      delete process.env.RBAC_ENFORCEMENT;
      const guard = new PermissionGuard(makeReflector('tenancy:write'), makeTenant(true), makeGifsyRoles([]));
      await expect(
        guard.canActivate(makeContext({ role: 'CLIENT_ADMIN', clientId: 'deoleo' })),
      ).resolves.toBe(true);
    });

    it('C2: env ON + tenant flag OFF → allow (fail-open)', async () => {
      process.env.RBAC_ENFORCEMENT = 'true';
      const guard = new PermissionGuard(makeReflector('tenancy:write'), makeTenant(false), makeGifsyRoles([]));
      await expect(
        guard.canActivate(makeContext({ role: 'CLIENT_ADMIN', clientId: 'deoleo' })),
      ).resolves.toBe(true);
    });

    it('C3: env ON + no user (non-@Public) → Unauthorized', async () => {
      process.env.RBAC_ENFORCEMENT = 'true';
      const guard = new PermissionGuard(makeReflector('kyc:read'), makeTenant(true), makeGifsyRoles([]));
      await expect(guard.canActivate(makeContext(null))).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('C4: env ON + tenant ON — GIFSY_ADMIN has ALL perms and never touches the resolver', async () => {
      process.env.RBAC_ENFORCEMENT = 'true';
      const roles = makeGifsyRoles([]);
      const guard = new PermissionGuard(makeReflector('wallet:adjust'), makeTenant(true), roles);
      await expect(
        guard.canActivate(makeContext({ role: 'GIFSY_ADMIN', clientId: 'gifsy' })),
      ).resolves.toBe(true);
      expect(roles.getPermissions).not.toHaveBeenCalled();
    });

    it('C5: env ON + tenant ON — CLIENT_ADMIN allowed on a held perm, denied on one it lacks', async () => {
      process.env.RBAC_ENFORCEMENT = 'true';
      const g1 = new PermissionGuard(makeReflector('kyc:read'), makeTenant(true), makeGifsyRoles([]));
      await expect(
        g1.canActivate(makeContext({ role: 'CLIENT_ADMIN', clientId: 'deoleo' })),
      ).resolves.toBe(true);

      const g2 = new PermissionGuard(makeReflector('tenancy:write'), makeTenant(true), makeGifsyRoles([]));
      await expect(
        g2.canActivate(makeContext({ role: 'CLIENT_ADMIN', clientId: 'deoleo' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
