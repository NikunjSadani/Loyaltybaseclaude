// GET /v1/admin/settings/features — the narrow feature-switches read (owner 2026-11-25).
// Runs the REAL RolesGuard + PermissionGuard against the REAL route metadata, then the handler.
// Run: npx jest src/admin-core/feature-flags.controller.spec.ts

import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminFeatureFlagsController } from './feature-flags.controller';
import { AdminSettingsController } from './settings.controller';
import { RolesGuard } from '../common/guards/roles.guard';
import { PermissionGuard } from '../common/guards/permission.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../common/decorators/require-permission.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

const FEATURES = { salesImport: true, walletModule: false, offerTiles: true, visibilityCaptureMode: 'AMOUNT_UPLOAD' };

function makeTenant() {
  return {
    resolveClient: jest.fn(async (clientId: string) => ({
      slug: clientId,
      name: `Internal ${clientId}`,
      loyaltyType: 'TRADE_LOYALTY',
      isActive: true,
      branding: { primaryColor: '#000', displayName: clientId },
      features: clientId === 'gifsy' ? { salesImport: false } : FEATURES,
    })),
    isFeatureEnabled: jest.fn().mockResolvedValue(false),
  };
}

function makeGrants(granted: Array<[string, string]>) {
  return {
    hasGrantUncached: jest.fn(async (userId: string, clientId: string) =>
      granted.some(([u, c]) => u === userId && c === clientId),
    ),
  };
}

// Staff role WITHOUT tenancy:read (prod "Project Manager" shape).
const gifsyRoles = { getPermissions: jest.fn().mockResolvedValue(new Set(['targets:read', 'targets:write'])) };

function ctxFor(user: JwtPayload, handler: (...a: never[]) => unknown, cls: unknown, query: Record<string, string> = {}) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user, query, headers: { 'x-tenant-slug': 'deoleo' } }) }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

/** Guards (real metadata) → handler. Throws whatever the first refusal throws. */
async function call(user: JwtPayload, tenant = makeTenant(), grants = makeGrants([['staff-1', 'bajaj']]), query: Record<string, string> = {}) {
  const reflector = new Reflector();
  const proto = AdminFeatureFlagsController.prototype;
  const ctx = ctxFor(user, proto.getFeatures, AdminFeatureFlagsController, query);
  expect(new RolesGuard(reflector).canActivate(ctx)).toBe(true);
  expect(await new PermissionGuard(reflector, tenant as never, gifsyRoles as never).canActivate(ctx)).toBe(true);
  const ctl = new AdminFeatureFlagsController(tenant as never, grants as never);
  return { res: await ctl.getFeatures(user), tenant, grants };
}

const staff = (o: Partial<JwtPayload> = {}): JwtPayload =>
  ({ sub: 'staff-1', role: 'GIFSY_STAFF', clientId: 'bajaj', assumed: true, gifsyRoleId: 'pm', phone: '', name: 'S', ...o }) as JwtPayload;

describe('GET /v1/admin/settings/features', () => {
  beforeEach(() => jest.clearAllMocks());

  it('route metadata: GIFSY_ADMIN/CLIENT_ADMIN/GIFSY_STAFF, no @RequirePermission', () => {
    const r = new Reflector();
    const h = AdminFeatureFlagsController.prototype.getFeatures;
    expect(r.get(ROLES_KEY, h)).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN', 'GIFSY_STAFF']);
    expect(r.get(PERMISSION_KEY, h)).toBeUndefined();
  });

  it('assumed staff WITH a grant (no tenancy:read) → 200, features ONLY', async () => {
    const { res, grants, tenant } = await call(staff());
    expect(Object.keys(res)).toEqual(['features']);
    expect(res.features).toEqual(FEATURES);
    expect(grants.hasGrantUncached).toHaveBeenCalledWith('staff-1', 'bajaj');
    expect(tenant.resolveClient).toHaveBeenCalledWith('bajaj');
  });

  it('assumed staff WITHOUT a grant for that tenant → 403, tenant never read', async () => {
    const tenant = makeTenant();
    await expect(call(staff({ clientId: 'deoleo' }), tenant)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tenant.resolveClient).not.toHaveBeenCalled();
  });

  it('staff with ZERO grants → 403', async () => {
    await expect(call(staff(), makeTenant(), makeGrants([]))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('UN-assumed staff (home gifsy) → 403, even with grants', async () => {
    const tenant = makeTenant();
    await expect(call(staff({ assumed: undefined, clientId: 'gifsy' }), tenant)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tenant.resolveClient).not.toHaveBeenCalled();
  });

  it('CLIENT_ADMIN → own tenant only; a query/header tenant cannot be injected', async () => {
    const user = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'C' } as JwtPayload;
    const { res, tenant, grants } = await call(user, makeTenant(), makeGrants([]), { clientId: 'deoleo', slug: 'deoleo' });
    expect(tenant.resolveClient).toHaveBeenCalledTimes(1);
    expect(tenant.resolveClient).toHaveBeenCalledWith('bajaj');
    expect(grants.hasGrantUncached).not.toHaveBeenCalled();
    expect(Object.keys(res)).toEqual(['features']);
  });

  it('GIFSY_ADMIN assumed → that tenant; un-assumed → platform tenant (same as /config)', async () => {
    const a = await call({ sub: 'o', role: 'GIFSY_ADMIN', clientId: 'bajaj', assumed: true, phone: '', name: 'O' } as JwtPayload);
    expect(a.res.features).toEqual(FEATURES);
    const b = await call({ sub: 'o', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: 'O' } as JwtPayload);
    expect(b.res.features).toEqual({ salesImport: false });
  });

  it.each(['MIS_USER', 'SALES_SO', 'RETAILER', 'VENDOR'])('%s → 403 at RolesGuard', (role) => {
    const user = { sub: 'x', role, clientId: 'bajaj', phone: '', name: 'X' } as JwtPayload;
    const ctx = ctxFor(user, AdminFeatureFlagsController.prototype.getFeatures, AdminFeatureFlagsController);
    expect(() => new RolesGuard(new Reflector()).canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('/config is NOT weakened: still tenancy:read, and a staff without it is refused', async () => {
    const r = new Reflector();
    const h = AdminSettingsController.prototype.getConfig;
    expect(r.get(ROLES_KEY, h)).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN']);
    expect(r.get(PERMISSION_KEY, h)).toBe('tenancy:read');
    const ctx = ctxFor(staff(), h, AdminSettingsController);
    await expect(new PermissionGuard(r, makeTenant() as never, gifsyRoles as never).canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
