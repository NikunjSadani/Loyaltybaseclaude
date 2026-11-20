import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { PushController } from '../../../push/push.controller';
import { PwaAdoptionService } from '../../../push/pwa-adoption.service';
import { ExportAccessChecker } from '../../export-access';
import type { GifsyRoleService } from '../../../common/rbac/gifsy-role.service';
import type { TenantService } from '../../../tenant/tenant.service';
import type { XlsxStreamWriter } from '../../../common/xlsx-stream';
import { EXPORT_KINDS } from '../index';
import {
  APP_INSTALLED_USERS_KIND,
  INSTALLED_USERS_ABOUT_SHEET,
  INSTALLED_USERS_HEADERS,
  INSTALLED_USERS_NONE_MESSAGE,
  istDayStart,
} from './app-installed-users.kind';
import { ctxFor, readBook, renderKind } from './parity.support-spec';

const CLIENT = { sub: 'ca', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' } as JwtPayload;
const MIS = { sub: 'mis', role: 'MIS_USER', clientId: 'bajaj', phone: '', name: '' } as JwtPayload;
const OWNER_ASSUMED = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'bajaj', assumed: true, phone: '', name: '' } as JwtPayload;
const OWNER_HOME = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'gifsy', phone: '', name: '' } as JwtPayload;
const DEOLEO = { sub: 'dca', role: 'CLIENT_ADMIN', clientId: 'deoleo', phone: '', name: '' } as JwtPayload;
const NO_TENANT = { ...CLIENT, clientId: '' } as JwtPayload;
const XLSX_TIMEOUT = 30_000;

const D = (iso: string) => new Date(iso);

interface FakeUser {
  id: string;
  clientId: string;
  name: string;
  phone: string;
  role: string;
  status: string;
  deletedAt: Date | null;
  salesUser: { hierarchyLevel: { code: string; name: string | null } | null } | null;
  channelPartner: unknown;
}
interface FakeInstall { userId: string; clientId: string; platform: string; installedAt: Date; lastSeenAt: Date | null }
interface InstallWhere {
  clientId: string;
  userId?: { in: string[] };
  user?: { clientId: string; deletedAt: null };
}

/**
 * bajaj: an ISR (2 platforms, notifications on, "+91" phone), a retailer partner (inactive), a client admin, a
 * suspended SO with no level, a SOFT-DELETED SO, and a Gifsy operator whose install row was recorded while assumed
 * into bajaj (belongs to gifsy). deoleo: one ASM whose level has its own name. The fake HONOURS every where.
 */
function makePrisma() {
  const users: FakeUser[] = [
    {
      id: 'u-isr', clientId: 'bajaj', name: 'Ravi', phone: '+91 90000 00001', role: 'SALES_ISR', status: 'ACTIVE', deletedAt: null,
      salesUser: { hierarchyLevel: { code: 'XSR', name: '' } }, channelPartner: null,
    },
    {
      id: 'u-ret', clientId: 'bajaj', name: '=HYPERLINK("http://evil","x")', phone: '919000000002', role: 'WHOLESALER',
      status: 'INACTIVE', deletedAt: null, salesUser: null,
      channelPartner: { partnerCode: 'P-1', outlets: [{ outletCode: 'BJ-001', name: 'Shree Stores', outletType: { code: 'RT', name: 'Retail' } }] },
    },
    { id: 'u-adm', clientId: 'bajaj', name: 'Asha', phone: '9000000003', role: 'CLIENT_ADMIN', status: 'ACTIVE', deletedAt: null, salesUser: null, channelPartner: null },
    { id: 'u-sus', clientId: 'bajaj', name: 'Sunil', phone: '9000000005', role: 'SALES_SO', status: 'SUSPENDED', deletedAt: null, salesUser: null, channelPartner: null },
    { id: 'u-del', clientId: 'bajaj', name: 'Old', phone: '9000000004', role: 'SALES_SO', status: 'ACTIVE', deletedAt: D('2026-10-05T00:00:00Z'), salesUser: null, channelPartner: null },
    { id: 'u-g', clientId: 'gifsy', name: 'Operator', phone: '9000000009', role: 'GIFSY_ADMIN', status: 'ACTIVE', deletedAt: null, salesUser: null, channelPartner: null },
    {
      id: 'u-deo', clientId: 'deoleo', name: 'Maria', phone: '9000000007', role: 'SALES_ASM', status: 'ACTIVE', deletedAt: null,
      salesUser: { hierarchyLevel: { code: 'ASM', name: 'Area Manager' } }, channelPartner: null,
    },
  ];
  const installs: FakeInstall[] = [
    { userId: 'u-isr', clientId: 'bajaj', platform: 'IOS', installedAt: D('2026-11-10T04:30:00Z'), lastSeenAt: D('2026-11-15T10:00:00Z') },
    { userId: 'u-isr', clientId: 'bajaj', platform: 'ANDROID', installedAt: D('2026-11-11T04:30:00Z'), lastSeenAt: D('2026-11-14T10:00:00Z') },
    { userId: 'u-ret', clientId: 'bajaj', platform: 'ANDROID', installedAt: D('2026-11-12T06:00:00Z'), lastSeenAt: D('2026-11-12T06:00:00Z') },
    { userId: 'u-adm', clientId: 'bajaj', platform: 'DESKTOP', installedAt: D('2026-10-01T00:00:00Z'), lastSeenAt: D('2026-10-02T00:00:00Z') },
    { userId: 'u-sus', clientId: 'bajaj', platform: 'ANDROID', installedAt: D('2026-09-15T00:00:00Z'), lastSeenAt: null },
    { userId: 'u-del', clientId: 'bajaj', platform: 'ANDROID', installedAt: D('2026-09-01T00:00:00Z'), lastSeenAt: D('2026-09-02T00:00:00Z') },
    { userId: 'u-g', clientId: 'bajaj', platform: 'ANDROID', installedAt: D('2026-11-13T00:00:00Z'), lastSeenAt: D('2026-11-13T00:00:00Z') },
    { userId: 'u-g', clientId: 'gifsy', platform: 'DESKTOP', installedAt: D('2026-11-01T00:00:00Z'), lastSeenAt: D('2026-11-01T00:00:00Z') },
    { userId: 'u-deo', clientId: 'deoleo', platform: 'ANDROID', installedAt: D('2026-11-02T00:00:00Z'), lastSeenAt: D('2026-11-03T00:00:00Z') },
  ];
  // Area data (reports/area/user-area.ts): bajaj ISR → SO → ASM "Priya"; the retailer's outlet is assigned to the ISR.
  const levels = [
    { clientId: 'bajaj', code: 'XSR', name: 'ISR', level: 1 },
    { clientId: 'bajaj', code: 'SO', name: 'SO', level: 2 },
    { clientId: 'bajaj', code: 'ASM', name: 'ASM', level: 3 },
    { clientId: 'deoleo', code: 'ASM', name: 'Area Manager', level: 3 },
  ];
  const su = (id: string, clientId: string, userId: string, code: string, reportingToId: string | null, name: string) => ({
    id, clientId, userId, reportingToId, isActive: true, deletedAt: null, employeeCode: id, zone: null,
    hierarchyLevel: { code }, user: { name, status: 'ACTIVE' },
  });
  const salesUsers = [
    su('su-isr', 'bajaj', 'u-isr', 'XSR', 'su-so', 'Ravi'),
    su('su-so', 'bajaj', 'u-so-x', 'SO', 'su-asm', 'Sohan'),
    su('su-asm', 'bajaj', 'u-asm-x', 'ASM', null, 'Priya'),
    su('su-deo', 'deoleo', 'u-deo', 'ASM', null, 'Maria'),
  ];
  const outlets = [
    {
      clientId: 'bajaj', id: 'o-ret', partnerId: 'P-1', isPrimary: true, createdAt: D('2026-01-01T00:00:00Z'),
      zone: 'West', state: 'Maharashtra', city: 'Pune', partner: { userId: 'u-ret' }, parent: null,
    },
  ];
  const assignments = [{ clientId: 'bajaj', salesUserId: 'su-isr', outletId: 'o-ret', partnerId: null }];
  const byId = new Map(users.map((u) => [u.id, u]));
  const matchInstall = (i: FakeInstall, w: InstallWhere) => {
    if (i.clientId !== w.clientId) return false;
    if (w.userId && !w.userId.in.includes(i.userId)) return false;
    if (w.user) {
      const u = byId.get(i.userId);
      if (!u || u.clientId !== w.user.clientId || u.deletedAt !== w.user.deletedAt) return false;
    }
    return true;
  };
  return {
    pwaInstall: {
      groupBy: jest.fn(async ({ where }: { where: InstallWhere }) => {
        const g = new Map<string, { userId: string; _min: { installedAt: Date | null }; _max: { lastSeenAt: Date | null } }>();
        for (const i of installs.filter((x) => matchInstall(x, where))) {
          const cur = g.get(i.userId) ?? { userId: i.userId, _min: { installedAt: null }, _max: { lastSeenAt: null } };
          if (!cur._min.installedAt || i.installedAt < cur._min.installedAt) cur._min.installedAt = i.installedAt;
          if (i.lastSeenAt && (!cur._max.lastSeenAt || i.lastSeenAt > cur._max.lastSeenAt)) cur._max.lastSeenAt = i.lastSeenAt;
          g.set(i.userId, cur);
        }
        return [...g.values()];
      }),
      findMany: jest.fn(async ({ where }: { where: InstallWhere }) =>
        installs.filter((i) => matchInstall(i, where)).map(({ userId, platform }) => ({ userId, platform })),
      ),
    },
    user: {
      findMany: jest.fn(
        async ({ where }: { where: { id: { in: string[] }; clientId: string; deletedAt?: null; role?: { in: string[] } } }) =>
          users.filter(
            (u) =>
              where.id.in.includes(u.id) &&
              u.clientId === where.clientId &&
              (where.deletedAt !== null || u.deletedAt === null) &&
              (!where.role || where.role.in.includes(u.role)),
          ),
      ),
    },
    pushSubscription: {
      groupBy: jest.fn(async () => [{ userId: 'u-isr' }]),
      findMany: jest.fn(async () => []),
    },
    outletTypeClientConfig: {
      findMany: jest.fn(async () => [{ displayName: 'Retailer', outletType: { code: 'RT' } }]),
    },
    salesHierarchyLevel: { findMany: jest.fn(async ({ where }: { where: { clientId: string } }) => levels.filter((l) => l.clientId === where.clientId)) },
    salesUser: { findMany: jest.fn(async ({ where }: { where: { clientId: string } }) => salesUsers.filter((s) => s.clientId === where.clientId)) },
    salesUserAssignment: {
      findMany: jest.fn(async ({ where }: { where: { salesUser: { clientId: string } } }) =>
        assignments.filter((a) => a.clientId === where.salesUser.clientId),
      ),
    },
    outlet: { findMany: jest.fn(async ({ where }: { where: { clientId: string } }) => outlets.filter((o) => o.clientId === where.clientId)) },
    auditLog: { create: jest.fn(async () => ({})) },
  };
}

async function build(user: JwtPayload, raw: Record<string, unknown> = {}, prisma = makePrisma()) {
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
    ...prisma.salesHierarchyLevel.findMany.mock.calls,
    ...prisma.salesUser.findMany.mock.calls,
    ...prisma.outlet.findMany.mock.calls,
  ] as unknown as Array<[{ where: Record<string, unknown> }]>;
  return calls.map((c) => c[0].where);
}

/** A writer that records when the workbook is touched (any byte of the file starts at addSheet). */
function spyWriter(events: string[]): XlsxStreamWriter {
  return {
    rowCount: 0,
    addSheet: jest.fn(async () => {
      events.push('addSheet');
      return { rowCount: 0, addRow: jest.fn(async () => { events.push('row'); }) };
    }),
    finish: jest.fn(async () => { events.push('finish'); }),
  } as unknown as XlsxStreamWriter;
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

  it('row shape: headers, newest first install first, labels, platforms, notifications, status, 10-digit phones', async () => {
    const { aoa, rowCount } = await build(CLIENT);
    expect(rowCount).toBe(4);
    expect(aoa[0]).toEqual([...INSTALLED_USERS_HEADERS]); // bajaj's ASM level is named "ASM"
    expect(aoa[0].slice(0, 9)).toEqual(['Name', 'Phone', 'Role', 'Role Group', 'ASM', 'Zone', 'State', 'City', 'Outlet Code']);
    // u-ret (11-12) → u-isr (11-10) → u-adm (10-01) → u-sus (09-15). NOT u-del (deleted), NOT u-g (Gifsy operator).
    expect(aoa.slice(1).map((r) => r[1])).toEqual(['9000000002', '9000000001', '9000000003', '9000000005']);
    expect(aoa[1]).toEqual([
      `'=HYPERLINK("http://evil","x")`, // xlsx-safe: formula neutralised
      '9000000002', // "919000000002" → last 10 digits
      'Retailer', // per-tenant outlet-type display name
      'Partner',
      'Priya', // the ASM of the ISR assigned to the outlet
      'West',
      'Maharashtra',
      'Pune',
      'BJ-001',
      'Shree Stores',
      'Android',
      '2026-11-12 11:30', // IST
      '2026-11-12 11:30',
      'No',
      'Inactive',
    ]);
    expect(aoa[2]).toEqual([
      'Ravi', '9000000001' /* "+91 90000 00001" — no apostrophe-prefixed "+91" cell */, 'ISR' /* empty level name → Bajaj label for XSR */,
      'Sales', 'Priya' /* ISR → SO → ASM */, 'West', 'Maharashtra', 'Pune' /* from the ISR's assigned outlet */,
      null, null, 'Android, iOS', '2026-11-10 10:00', '2026-11-15 15:30', 'Yes', 'Active',
    ]);
    expect(typeof aoa[2][1]).toBe('string'); // phone stays text
    expect(aoa[3].slice(2, 4)).toEqual(['Client admin', 'Admin']);
    expect(aoa[3].slice(4, 8)).toEqual(Array(4).fill('Not in sales hierarchy'));
    expect(aoa[3][10]).toBe('Desktop');
    expect(aoa[4][2]).toBe('SO'); // no level → from the role
    expect(aoa[4].slice(4, 8)).toEqual(Array(4).fill('Not set')); // a sales login with no employee record
    expect(aoa[4][12]).toBeNull(); // no last-seen
    expect(aoa[4][14]).toBe('Suspended'); // inactive / suspended users are KEPT
    expect(aoa.flat()).not.toContain('Old');
    expect(aoa.flat()).not.toContain('9000000004');
    expect(aoa.flat()).not.toContain('Operator');
  }, XLSX_TIMEOUT);

  it("sales role label = the tenant's own level name (Deoleo), not a Bajaj rung label", async () => {
    const { aoa } = await build(DEOLEO);
    expect(aoa.slice(1).map((r) => [r[0], r[2], r[3]])).toEqual([['Maria', 'Area Manager', 'Sales']]);
    // the ASM column header is the tenant's own level name; an ASM shows their own name; no outlets → "Not set"
    expect(aoa[0].slice(4, 8)).toEqual(['Area Manager', 'Zone', 'State', 'City']);
    expect(aoa[1].slice(4, 8)).toEqual(['Maria', 'Not set', 'Not set', 'Not set']);
  }, XLSX_TIMEOUT);

  it('an "About" sheet explains the area columns', async () => {
    const prisma = makePrisma();
    const { buffer } = await renderKind(APP_INSTALLED_USERS_KIND, ctxFor(CLIENT, prisma), { roleGroup: null, since: null });
    const about = readBook(buffer).sheets[INSTALLED_USERS_ABOUT_SHEET].aoa;
    expect(about[0][0]).toBe('About this report');
    expect(about.slice(1).map((r) => r[0])).toEqual(['ASM', 'Zone / State / City', 'Not set / Not in hierarchy']);
    expect(String(about[1][1])).toMatch(/above the ASM level show "Above ASM level"/);
    expect(String(about[3][1])).toMatch(/Not in sales hierarchy/);
  }, XLSX_TIMEOUT);

  it('2,000 installed users → area data read ONCE (4 reads), not per row', async () => {
    const prisma = makePrisma();
    const many = Array.from({ length: 2_000 }, (_, i) => ({ userId: `bulk-${i}`, _min: { installedAt: D('2026-11-01T00:00:00Z') }, _max: { lastSeenAt: null } }));
    prisma.pwaInstall.groupBy.mockResolvedValueOnce(many as never);
    prisma.user.findMany.mockImplementation((async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({ id, name: id, phone: '9000000000', role: 'SALES_ISR', status: 'ACTIVE', salesUser: null, channelPartner: null }))) as never);
    const { rowCount } = await build(CLIENT, {}, prisma);
    expect(rowCount).toBe(2_000);
    for (const m of [prisma.salesHierarchyLevel, prisma.salesUser, prisma.salesUserAssignment, prisma.outlet]) {
      expect(m.findMany).toHaveBeenCalledTimes(1);
    }
    expect(prisma.user.findMany).toHaveBeenCalledTimes(2); // pre-existing 1,000-user batches — 2 reads for 2,000 rows
  }, XLSX_TIMEOUT);

  it('soft-deleted users are excluded at BOTH reads (install population + user read)', async () => {
    const { prisma } = await build(CLIENT);
    expect(prisma.pwaInstall.groupBy.mock.calls[0][0].where).toEqual({
      clientId: 'bajaj',
      user: { clientId: 'bajaj', deletedAt: null },
    });
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ clientId: 'bajaj', deletedAt: null });
  }, XLSX_TIMEOUT);

  it('the App Adoption page count and the unfiltered file row count are the SAME population', async () => {
    for (const user of [CLIENT, OWNER_HOME, DEOLEO]) {
      const prisma = makePrisma();
      const page = await new PwaAdoptionService(prisma as never).adoption(user.clientId);
      const { rowCount } = await build(user, {}, prisma);
      expect(rowCount).toBe(page.installed.users);
    }
  }, XLSX_TIMEOUT);

  it('filters: roleGroup narrows by role; since keeps first installs on/after that IST day', async () => {
    const sales = await build(CLIENT, { roleGroup: 'sales' });
    expect(sales.prisma.user.findMany.mock.calls[0][0].where.role).toEqual({
      in: ['SALES_HO', 'SALES_STATE_HEAD', 'SALES_ASM', 'SALES_SO', 'SALES_ISR'],
    });
    expect(sales.aoa.slice(1).map((r) => r[0])).toEqual(['Ravi', 'Sunil']);

    const since = await build(CLIENT, { since: '2026-11-10' });
    expect(since.aoa.slice(1).map((r) => r[0])).toEqual([`'=HYPERLINK("http://evil","x")`, 'Ravi']);
  }, XLSX_TIMEOUT);

  it('0 matching users → 404 "0 users matched these filters." — no audit row, no workbook bytes', async () => {
    const prisma = makePrisma();
    const events: string[] = [];
    await expect(
      APP_INSTALLED_USERS_KIND.run(ctxFor(CLIENT, prisma), { roleGroup: 'admin', since: '2026-11-01' }, spyWriter(events)),
    ).rejects.toThrow(new NotFoundException(INSTALLED_USERS_NONE_MESSAGE));
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('writes ONE audit row per file — BEFORE any workbook byte: who, tenant, exact row count, filters', async () => {
    const prisma = makePrisma();
    const events: string[] = [];
    prisma.auditLog.create.mockImplementation(async () => {
      events.push('audit');
      return {};
    });
    const res = await APP_INSTALLED_USERS_KIND.run(
      ctxFor(OWNER_ASSUMED, prisma),
      { roleGroup: 'partner', since: '2026-11-01' },
      spyWriter(events),
    );
    expect(res.rowCount).toBe(1);
    expect(events).toEqual(['audit', 'addSheet', 'row', 'addSheet', 'row', 'row', 'row']); // data sheet, then "About"
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
  });

  it('a failed audit write fails the download BEFORE any byte of the file (never an unaudited file)', async () => {
    const prisma = makePrisma();
    prisma.auditLog.create.mockRejectedValueOnce(new Error('db down'));
    const events: string[] = [];
    await expect(
      APP_INSTALLED_USERS_KIND.run(ctxFor(CLIENT, prisma), { roleGroup: null, since: null }, spyWriter(events)),
    ).rejects.toThrow('db down');
    expect(events).toEqual([]); // the workbook was never started → the light stream answers with an error, no file
  });

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
