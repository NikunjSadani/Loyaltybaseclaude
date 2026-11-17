import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { GifsyRoleService } from '../common/rbac/gifsy-role.service';
import type { TenantService } from '../tenant/tenant.service';
import { ExportAccessChecker } from './export-access';
import type { ExportAccess } from './export-kinds';

/**
 * PARITY: ExportAccessChecker must decide exactly like RolesGuard + PermissionGuard on a route decorated with the
 * same @Roles / @RequirePermission. Runs the REAL guards and the checker over a matrix and compares.
 */
const STAFF_ROLE_PERMS: Record<string, string[]> = {
  'role-reports': ['reports:export', 'targets:read'],
  'role-none': [],
};
const gifsyRoles = {
  getPermissions: jest.fn(async (id?: string | null) => new Set(STAFF_ROLE_PERMS[id ?? ''] ?? [])),
} as unknown as GifsyRoleService;
let rbacTenantOn = false;
const tenant = { isFeatureEnabled: jest.fn(async () => rbacTenantOn) } as unknown as TenantService;

function reflectorFor(access: ExportAccess): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === ROLES_KEY) return [...access.roles];
      if (key === PERMISSION_KEY) return access.permission;
      return undefined; // isPublic
    },
  } as unknown as Reflector;
}

function ctxFor(user: JwtPayload): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

async function guardsAllow(user: JwtPayload, access: ExportAccess): Promise<boolean> {
  const reflector = reflectorFor(access);
  try {
    if (!new RolesGuard(reflector).canActivate(ctxFor(user))) return false;
    return await new PermissionGuard(reflector, tenant, gifsyRoles).canActivate(ctxFor(user));
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
}

const u = (role: string, extra: Partial<JwtPayload> = {}): JwtPayload => ({
  sub: `u-${role}`,
  role,
  clientId: 'bajaj',
  phone: '',
  name: role,
  ...extra,
});

const USERS: JwtPayload[] = [
  u('GIFSY_ADMIN'),
  u('GIFSY_ADMIN', { assumed: true }),
  u('GIFSY_STAFF', { gifsyRoleId: 'role-reports', assumed: true }),
  u('GIFSY_STAFF', { gifsyRoleId: 'role-none', assumed: true }),
  u('GIFSY_STAFF'),
  u('CLIENT_ADMIN'),
  u('MIS_USER'),
  u('SALES_USER'),
  u('CHANNEL_PARTNER'),
];

const ACCESSES: ExportAccess[] = [
  { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'reports:export' },
  { roles: ['CLIENT_ADMIN', 'GIFSY_ADMIN'], permission: 'targets:read' },
  { roles: ['GIFSY_ADMIN'] },
  { roles: ['GIFSY_ADMIN', 'MIS_USER'], permission: 'reports:export' },
  { roles: ['GIFSY_ADMIN'], permission: 'users:manage_roles' },
  { roles: [] },
];

describe('ExportAccessChecker — parity with RolesGuard + PermissionGuard', () => {
  const checker = new ExportAccessChecker(gifsyRoles, tenant);
  const prevEnv = process.env.RBAC_ENFORCEMENT;
  afterAll(() => {
    process.env.RBAC_ENFORCEMENT = prevEnv;
  });

  for (const [label, env, tenantOn] of [
    ['RBAC off', undefined, false],
    ['RBAC env on, tenant off', 'true', false],
    ['RBAC env on, tenant on', 'true', true],
  ] as const) {
    it(`matches the guards for every role × access (${label})`, async () => {
      if (env) process.env.RBAC_ENFORCEMENT = env;
      else delete process.env.RBAC_ENFORCEMENT;
      rbacTenantOn = tenantOn;
      const mismatches: string[] = [];
      for (const user of USERS) {
        for (const access of ACCESSES) {
          const expected = await guardsAllow(user, access);
          const got = await checker.allowed(user, access);
          if (expected !== got) mismatches.push(`${user.role}/${user.gifsyRoleId ?? '-'} ${JSON.stringify(access)}: guards=${expected} checker=${got}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  it('denies a sales user and a staff without the permission (sanity, not just parity)', async () => {
    delete process.env.RBAC_ENFORCEMENT;
    const access = { roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'reports:export' };
    expect(await checker.allowed(u('SALES_USER'), access)).toBe(false);
    expect(await checker.allowed(u('GIFSY_STAFF', { gifsyRoleId: 'role-none' }), access)).toBe(false);
    expect(await checker.allowed(u('GIFSY_STAFF', { gifsyRoleId: 'role-reports' }), access)).toBe(true);
    expect(await checker.allowed(u('CLIENT_ADMIN'), access)).toBe(true);
    await expect(checker.assert(u('SALES_USER'), access)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
