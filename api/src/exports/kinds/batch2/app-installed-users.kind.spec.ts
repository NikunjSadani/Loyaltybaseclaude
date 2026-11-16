import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { PushController } from '../../../push/push.controller';
import { ExportAccessChecker } from '../../export-access';
import type { GifsyRoleService } from '../../../common/rbac/gifsy-role.service';
import type { TenantService } from '../../../tenant/tenant.service';
import { EXPORT_KINDS } from '../index';
import { APP_INSTALLED_USERS_KIND, INSTALLED_USERS_HEADERS, istDayStart } from './app-installed-users.kind';
import { ctxFor, readBook, renderKind } from './parity.support-spec';

const CLIENT = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' } as JwtPayload;
const MIS = { sub: 'mis', role: 'MIS_USER', clientId: 'bajaj', phone: '', name: '' } as JwtPayload;
const OWNER_ASSUMED = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'bajaj', assumed: true, phone: '', name: '' } as JwtPayload;
const OWNER_HOME = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' } as JwtPayload;
const NO_TENANT = { ...CLIENT, clientId: '' } as JwtPayload;
const XLSX_TIMEOUT = 30_000;

const D = (iso: string) => new Date(iso);

/** A tenant with: a Bajaj ISR (2 platforms, notifications on), a retailer partner, a client admin, a deleted user. */
function makePrisma() {
  const groups = [
    { userId: 'u-isr', _min: { installedAt: D('2026-11-10T04:30:00Z') }, _max: { lastSeenAt: D('2026-11-15T10:00:00Z') } },
    { userId: 'u-ret', _min: { installedAt: D('2026-11-12T06:00:00Z') }, _max: { lastSeenAt: D('2026-11-12T06:00:00Z') } },
    { userId: 'u-adm', _min: { installedAt: D('2026-10-01T00:00:00Z') }, _max: { lastSeenAt: D('2026-10-02T00:00:00Z') } },
    { userId: 'u-del', _min: { installedAt: D('2026-09-01T00:00:00Z') }, _max: { lastSeenAt: null } },
  ];
  const users = [
    {
      id: 'u-isr', name: 'Ravi', phone: '9000000001', role: 'SALES_ISR', status: 'ACTIVE', deletedAt: null,
      salesUser: { hierarchyLevel: { code: 'XSR' } }, channelPartner: null,
    },
    {
      id: 'u-ret', name: '=HYPERLINK("http://evil","x")', phone: '9000000002', role: 'WHOLESALER', status: 'INACTIVE', deletedAt: null,
      salesUser: null,
      channelPartner: { partnerCode: 'P-1', outlets: [{ outletCode: 'BJ-001', name: 'Shree Stores', outletType: { code: 'RT', name: 'Retail' } }] },
    },
    { id: 'u-adm', name: 'Asha', phone: '9000000003', role: 'CLIENT_ADMIN', status: 'ACTIVE', deletedAt: null, salesUser: null, channelPartner: null },
    { id: 'u-del', name: 'Old', phone: '9000000004', role: 'SALES_SO', status: 'ACTIVE', deletedAt: D('2026-10-05T00:00:00Z'), salesUser: null, channelPartner: null },
  ];
  const installs = [
    { userId: 'u-isr', platform: 'IOS' },
    { userId: 'u-isr', platform: 'ANDROID' },
    { userId: 'u-ret', platform: 'ANDROID' },
    { userId: 'u-adm', platform: 'DESKTOP' },
    { userId: 'u-del', platform: 'ANDROID' },
  ];
  return {
    pwaInstall: {
      groupBy: jest.fn(async () => groups),
      findMany: jest.fn(async ({ where }: { where: { userId: { in: string[] } } }) => installs.filter((i) => where.userId.in.includes(i.userId))),
    },
    user: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] }; role?: { in: string[] } } }) =>
        users.filter((u) => where.id.in.includes(u.id) && (!where.role || where.role.in.includes(u.role))),
      ),
    },
    pushSubscription: { groupBy: jest.fn(async () => [{ userId: 'u-isr' }]) },
    outletTypeClientConfig: {
      findMany: jest.fn(async () => [{ displayName: 'Retailer', outletType: { code: 'RT' } }]),
    },
    auditLog: { create: jest.fn(async () => ({})) },
  };
}

async function build(user: JwtPayload, raw: Record<string, unknown> = {}) {
  const prisma = makePrisma();
  const params = APP_INSTALLED_USERS_KIND.parseParams(raw, user);
  const { buffer, rowCount } = await renderKind(APP_INSTALLED_USERS_KIND, ctxFor(user, prisma), params);
  const aoa = readBook(buffer).sheets['Installed users'].aoa;
  return { prisma, rowCount, aoa };
}

function allWheres(prisma: ReturnType<typeof makePrisma>): Array<Record<string, unknown>> {
  const calls = [
    ...prisma.pwaInstall.groupBy.mock.calls,
    ...prisma.pwaInstall.findMany.mock.calls,
    ...prisma.user.findMany.mock.calls,
    ...prisma.pushSubscription.groupBy.mock.calls,
    ...prisma.outletTypeClientConfig.findMany.mock.calls,
  ] as unknown as Array<[{ where: Record<string, unknown> }]>;
  return calls.map((c) => c[0].where);
}

describe('app-installed-users export kind', () => {
  it('is registered and light (always streams instantly)', () => {
    expect(EXPORT_KINDS.get('app-installed-users')).toBe(APP_INSTALLED_USERS_KIND);
    expect(APP_INSTALLED_USERS_KIND.isHeavy({ roleGroup: null, since: null })).toBe(false);
    expect(APP_INSTALLED_USERS_KIND.fileName({ roleGroup: null, since: null }, D('2026-11-16T05:00:00Z'))).toBe(
      'app-installed-users-2026-11-16.xlsx',
    );
  });

  describe('tenant scoping (same as GET /v1/push/adoption — the JWT clientId, never cross-tenant)', () => {
    it.each([
      ['CLIENT_ADMIN', CLIENT, 'bajaj'],
      ['MIS_USER', MIS, 'bajaj'],
      ['assumed GIFSY_ADMIN', OWNER_ASSUMED, 'bajaj'],
      ['un-assumed GIFSY_ADMIN → home tenant only, NOT all tenants', OWNER_HOME, 'gifsy'],
    ])('%s → every read pinned to %s', async (_label, user, expected) => {
      const { prisma } = await build(user as JwtPayload);
      const wheres = allWheres(prisma);
      expect(wheres.length).toBeGreaterThanOrEqual(5);
      for (const w of wheres) expect(w.clientId).toBe(expected);
    }, XLSX_TIMEOUT);

    it('a caller with no tenant is refused before any read (request time and run time)', async () => {
      expect(() => APP_INSTALLED_USERS_KIND.parseParams({}, NO_TENANT)).toThrow(ForbiddenException);
      const prisma = makePrisma();
      await expect(
        renderKind(APP_INSTALLED_USERS_KIND, ctxFor(NO_TENANT, prisma), { roleGroup: null, since: null }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.pwaInstall.groupBy).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });

  it('row shape: headers, newest first install first, labels, platforms, notifications, status', async () => {
    const { aoa, rowCount } = await build(CLIENT);
    expect(rowCount).toBe(4);
    expect(aoa[0]).toEqual([...INSTALLED_USERS_HEADERS]);
    // u-ret (11-12) → u-isr (11-10) → u-adm (10-01) → u-del (09-01)
    expect(aoa.slice(1).map((r) => r[1])).toEqual(['9000000002', '9000000001', '9000000003', '9000000004']);
    expect(aoa[1]).toEqual([
      `'=HYPERLINK("http://evil","x")`, // xlsx-safe: formula neutralised
      '9000000002',
      'Retailer', // per-tenant outlet-type display name
      'Partner',
      'BJ-001',
      'Shree Stores',
      'Android',
      '2026-11-12 11:30', // IST
      '2026-11-12 11:30',
      'No',
      'Inactive',
    ]);
    expect(aoa[2]).toEqual([
      'Ravi', '9000000001', 'ISR' /* Bajaj label for XSR */, 'Sales', null, null, 'Android, iOS',
      '2026-11-10 10:00', '2026-11-15 15:30', 'Yes', 'Active',
    ]);
    expect(aoa[3].slice(2, 4)).toEqual(['Client admin', 'Admin']);
    expect(aoa[3][6]).toBe('Desktop');
    expect(aoa[4][2]).toBe('SO');
    expect(aoa[4][8]).toBeNull(); // no last-seen
    expect(aoa[4][10]).toBe('Deleted');
  }, XLSX_TIMEOUT);

  it('filters: roleGroup narrows by role; since keeps first installs on/after that IST day', async () => {
    const sales = await build(CLIENT, { roleGroup: 'sales' });
    expect(sales.prisma.user.findMany.mock.calls[0][0].where.role).toEqual({
      in: ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'],
    });
    expect(sales.aoa.slice(1).map((r) => r[0])).toEqual(['Ravi', 'Old']);

    const since = await build(CLIENT, { since: '2026-11-10' });
    expect(since.aoa.slice(1).map((r) => r[0])).toEqual([`'=HYPERLINK("http://evil","x")`, 'Ravi']);
  }, XLSX_TIMEOUT);

  it('writes ONE audit row per file: who, tenant, row count, filters', async () => {
    const { prisma } = await build(OWNER_ASSUMED, { roleGroup: 'partner', since: '2026-11-01' });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: 'EXPORT',
        entityType: 'APP_ADOPTION',
        entityId: 'bajaj',
        actorId: 'g',
        metadata: {
          route: 'installed-users',
          clientId: 'bajaj',
          assumed: true,
          actorRole: 'GIFSY_ADMIN',
          rowCount: 1,
          filters: { roleGroup: 'partner', since: '2026-11-01' },
        },
      },
    });
  }, XLSX_TIMEOUT);

  it('a failed audit write fails the download (never an unaudited file)', async () => {
    const prisma = makePrisma();
    prisma.auditLog.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      renderKind(APP_INSTALLED_USERS_KIND, ctxFor(CLIENT, prisma), { roleGroup: null, since: null }),
    ).rejects.toThrow('db down');
  }, XLSX_TIMEOUT);

  it('validates params with readable 400s', () => {
    const parse = (raw: Record<string, unknown>) => APP_INSTALLED_USERS_KIND.parseParams(raw, CLIENT);
    expect(parse({})).toEqual({ roleGroup: null, since: null });
    expect(parse({ roleGroup: 'admin', since: '2026-11-01' })).toEqual({ roleGroup: 'admin', since: '2026-11-01' });
    expect(() => parse({ roleGroup: 'vendor' })).toThrow(BadRequestException);
    expect(() => parse({ since: '01-11-2026' })).toThrow(BadRequestException);
    expect(() => parse({ since: '2026-02-31' })).toThrow(BadRequestException);
    expect(() => parse({ clientId: 'deoleo' })).toThrow(BadRequestException); // no tenant param exists
    expect(istDayStart('2026-11-01')?.toISOString()).toBe('2026-10-31T18:30:00.000Z');
  });

  describe('role guard', () => {
    const access = new ExportAccessChecker(
      { getPermissions: async () => new Set() } as unknown as GifsyRoleService,
      { isFeatureEnabled: async () => false } as unknown as TenantService,
    );

    it('endpoint carries the SAME @Roles as GET adoption, and the kind access mirrors it', () => {
      const reflector = new Reflector();
      const proto = PushController.prototype;
      const roles = reflector.get(ROLES_KEY, proto.installedUsers);
      expect(roles).toEqual(reflector.get(ROLES_KEY, proto.getAdoption));
      expect(roles).toEqual(['GIFSY_ADMIN', 'CLIENT_ADMIN', 'MIS_USER']);
      expect([...APP_INSTALLED_USERS_KIND.access.roles]).toEqual(roles);
      expect(APP_INSTALLED_USERS_KIND.access.permission).toBeUndefined();
    });

    it.each(['SALES_ISR', 'SALES_SO', 'WHOLESALER', 'SSS', 'VENDOR', 'GIFSY_STAFF'])('%s is refused', async (role) => {
      await expect(access.assert({ ...CLIENT, role } as JwtPayload, APP_INSTALLED_USERS_KIND.access)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it.each([CLIENT, MIS, OWNER_ASSUMED, OWNER_HOME])('$role is allowed', async (user) => {
      await expect(access.assert(user, APP_INSTALLED_USERS_KIND.access)).resolves.toBeUndefined();
    });

    it('controller delegates to ExportsService.respond with the kind + raw query', async () => {
      const respond = jest.fn(async () => 'file');
      const ctrl = new PushController({} as never, {} as never, {} as never, {} as never, { respond } as never);
      const res = {} as never;
      await expect(ctrl.installedUsers(CLIENT, { roleGroup: 'sales' }, res)).resolves.toBe('file');
      expect(respond).toHaveBeenCalledWith(res, CLIENT, 'app-installed-users', { roleGroup: 'sales' });
    });
  });
});
