import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { PERMISSION_KEY } from '../../../common/decorators/require-permission.decorator';
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
  installedUsersHeaders,
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
  salesUser: { employeeCode: string | null; deletedAt?: Date | null; hierarchyLevel: { code: string; name: string | null } | null } | null;
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
interface Tweak {
  users: FakeUser[];
  installs: FakeInstall[];
  levels: Array<{ clientId: string; code: string; name: string; level: number }>;
  salesUsers: Array<ReturnType<typeof suRow>>;
  outlets: Array<Record<string, unknown>>;
  assignments: Array<{ clientId: string; salesUserId: string; outletId: string | null; partnerId: string | null }>;
}

const suRow = (id: string, clientId: string, userId: string, code: string, reportingToId: string | null, name: string, isActive = true) => ({
  id, clientId, userId, reportingToId, isActive, deletedAt: null as Date | null, employeeCode: id, zone: null,
  hierarchyLevel: { code }, user: { name, status: 'ACTIVE' },
});

function makePrisma(tweak?: (d: Tweak) => void) {
  const users: FakeUser[] = [
    {
      id: 'u-isr', clientId: 'bajaj', name: 'Ravi', phone: '+91 90000 00001', role: 'SALES_ISR', status: 'ACTIVE', deletedAt: null,
      salesUser: { employeeCode: ' EMP-ISR-1 ', hierarchyLevel: { code: 'XSR', name: '' } }, channelPartner: null,
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
      // a SOFT-DELETED SalesUser row (the login's only one — userId @unique) still shows its employee code
      salesUser: { employeeCode: 'DEO-77', deletedAt: D('2026-10-01T00:00:00Z'), hierarchyLevel: { code: 'ASM', name: 'Area Manager' } }, channelPartner: null,
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
  // Area data (reports/area/user-area.ts): bajaj ISR → SO → ASM "Priya" → SM → ZH → NSM (Bajaj level names);
  // the retailer's outlet is assigned to the ISR. Deoleo = its PROD naming (levels named by their codes) + an ASM
  // level the tenant renamed "Area Manager".
  const levels = [
    { clientId: 'bajaj', code: 'XSR', name: 'ISR', level: 1 },
    { clientId: 'bajaj', code: 'SO', name: 'SO', level: 2 },
    { clientId: 'bajaj', code: 'ASM', name: 'ASM', level: 3 },
    { clientId: 'bajaj', code: 'RSM', name: 'SM', level: 4 },
    { clientId: 'bajaj', code: 'ZNM', name: 'ZH', level: 5 },
    { clientId: 'bajaj', code: 'NSM', name: 'NSM', level: 6 },
    { clientId: 'deoleo', code: 'XSR', name: 'XSR', level: 1 },
    { clientId: 'deoleo', code: 'SO', name: 'SO', level: 2 },
    { clientId: 'deoleo', code: 'ASM', name: 'Area Manager', level: 3 },
    { clientId: 'deoleo', code: 'RSM', name: 'RSM', level: 4 },
    { clientId: 'deoleo', code: 'ZNM', name: 'ZNM', level: 5 },
    { clientId: 'deoleo', code: 'NSM', name: 'NSM', level: 6 },
  ];
  const su = suRow;
  const salesUsers = [
    su('su-isr', 'bajaj', 'u-isr', 'XSR', 'su-so', 'Ravi'),
    su('su-so', 'bajaj', 'u-so-x', 'SO', 'su-asm', 'Sohan'),
    su('su-asm', 'bajaj', 'u-asm-x', 'ASM', 'su-sm', 'Priya'),
    su('su-sm', 'bajaj', 'u-sm-x', 'RSM', 'su-zh', 'Sameer'),
    su('su-zh', 'bajaj', 'u-zh-x', 'ZNM', 'su-nsm', 'Zoya'),
    su('su-nsm', 'bajaj', 'u-nsm-x', 'NSM', null, 'Nikhil'),
    su('su-deo', 'deoleo', 'u-deo', 'ASM', null, 'Maria'),
  ];
  const outlets = [
    {
      clientId: 'bajaj', id: 'o-ret', partnerId: 'P-1', isPrimary: true, createdAt: D('2026-01-01T00:00:00Z'),
      zone: 'West', state: 'Maharashtra', city: 'Pune', partner: { userId: 'u-ret' }, parent: null,
    },
  ];
  const assignments: Tweak['assignments'] = [{ clientId: 'bajaj', salesUserId: 'su-isr', outletId: 'o-ret', partnerId: null }];
  tweak?.({ users, installs, levels, salesUsers, outlets, assignments });
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
    // ASM (name) column removed 2026-11-23; the five lowest levels' ID columns follow Employee ID (Bajaj names).
    expect(aoa[0]).toEqual([
      'Name', 'Phone', 'Role', 'Role Group', 'Zone', 'State', 'City', 'Employee ID',
      'ISR ID', 'SO ID', 'ASM ID', 'SM ID', 'ZH ID',
      'Outlet Code', 'Outlet Name', 'Platforms Installed', 'First Installed (IST)', 'Last Seen (IST)', 'Notifications Enabled', 'User Status',
    ]);
    expect(INSTALLED_USERS_HEADERS).not.toContain('ASM');
    // u-ret (11-12) → u-isr (11-10) → u-adm (10-01) → u-sus (09-15). NOT u-del (deleted), NOT u-g (Gifsy operator).
    expect(aoa.slice(1).map((r) => r[1])).toEqual(['9000000002', '9000000001', '9000000003', '9000000005']);
    expect(aoa[1]).toEqual([
      `'=HYPERLINK("http://evil","x")`, // xlsx-safe: formula neutralised
      '9000000002', // "919000000002" → last 10 digits
      'Retailer', // per-tenant outlet-type display name
      'Partner',
      'West',
      'Maharashtra',
      'Pune',
      null, // Employee ID: a partner has no sales employee record → blank (as Outlet Code is for a sales user)
      'su-isr', 'su-so', 'su-asm', 'su-sm', 'su-zh', // the covering ISR's chain (codes only)
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
      'Sales', 'West', 'Maharashtra', 'Pune' /* from the ISR's assigned outlet */,
      'EMP-ISR-1' /* Employee ID = SalesUser.employeeCode (trimmed) */,
      'su-isr', 'su-so', 'su-asm', 'su-sm', 'su-zh' /* own code, then every manager above (NSM is above rank 5) */,
      null, null /* no outlet → blank Outlet Code / Name */, 'Android, iOS', '2026-11-10 10:00', '2026-11-15 15:30', 'Yes', 'Active',
    ]);
    expect(typeof aoa[2][1]).toBe('string'); // phone stays text
    expect(aoa[3].slice(2, 4)).toEqual(['Client admin', 'Admin']);
    expect(aoa[3].slice(4, 7)).toEqual(Array(3).fill('Not in sales hierarchy'));
    expect(aoa[3][7]).toBeNull(); // an admin has no employee record → blank Employee ID
    expect(aoa[3].slice(8, 13)).toEqual(Array(5).fill(null)); // admin → every level-ID cell blank
    expect(aoa[3][15]).toBe('Desktop');
    expect(aoa[4][2]).toBe('SO'); // no level → from the role
    expect(aoa[4].slice(4, 7)).toEqual(Array(3).fill('Not set')); // a sales login with no employee record
    expect(aoa[4][7]).toBeNull(); // a sales login with no SalesUser row → blank Employee ID
    expect(aoa[4].slice(8, 13)).toEqual(Array(5).fill(null)); // …and blank level IDs (no employee record)
    expect(aoa[4][17]).toBeNull(); // no last-seen
    expect(aoa[4][19]).toBe('Suspended'); // inactive / suspended users are KEPT
    expect(aoa.flat()).not.toContain('Old');
    expect(aoa.flat()).not.toContain('9000000004');
    expect(aoa.flat()).not.toContain('Operator');
  }, XLSX_TIMEOUT);

  it("sales role label = the tenant's own level name (Deoleo), not a Bajaj rung label", async () => {
    const { aoa } = await build(DEOLEO);
    expect(aoa.slice(1).map((r) => [r[0], r[2], r[3]])).toEqual([['Maria', 'Area Manager', 'Sales']]);
    // Deoleo's own level names (prod: named by their codes; the ASM level renamed "Area Manager") + " ID".
    expect(aoa[0].slice(4, 13)).toEqual(['Zone', 'State', 'City', 'Employee ID', 'XSR ID', 'SO ID', 'Area Manager ID', 'RSM ID', 'ZNM ID']);
    expect(aoa[1].slice(4, 7)).toEqual(['Not set', 'Not set', 'Not set']); // no outlets → "Not set"
    expect(aoa[1][7]).toBe('DEO-77'); // Employee ID shown for every tenant, incl. Deoleo
    // An ASM with no manager: blank below, own code, "Not set" for the empty levels above.
    expect(aoa[1].slice(8, 13)).toEqual([null, null, 'su-deo', 'Not set', 'Not set']);
  }, XLSX_TIMEOUT);

  it('an "About" sheet explains the area columns', async () => {
    const prisma = makePrisma();
    const { buffer } = await renderKind(APP_INSTALLED_USERS_KIND, ctxFor(CLIENT, prisma), { roleGroup: null, since: null });
    const about = readBook(buffer).sheets[INSTALLED_USERS_ABOUT_SHEET].aoa;
    expect(about[0][0]).toBe('About this report');
    expect(about.slice(1).map((r) => r[0])).toEqual([
      'Zone / State / City', 'Not set / Not in hierarchy', '"N cities" / "N states"',
      'ISR ID · SO ID · ASM ID · SM ID · ZH ID',
      'Level IDs — sales users', 'Level IDs — retailers / wholesalers', 'Level IDs — admin / Gifsy / vendor',
    ]);
    expect(String(about[3][1])).toMatch(/City shows "<N> cities"/);
    expect(String(about[2][1])).toMatch(/Not in sales hierarchy/);
    expect(String(about[4][1])).toMatch(/employee codes only \(no names or phones\) for this client's five lowest sales levels, ISR up to ZH/);
    expect(String(about[5][1])).toMatch(/Blank = a level BELOW them/);
    expect(String(about[5][1])).toMatch(/"Vacant \(code\)"/);
    expect(String(about[6][1])).toMatch(/separated by " \| "/);
    expect(String(about[7][1])).toMatch(/always blank/);
    // This file's own area wording (three area columns; no ASM name column) — not the Usage report's notes.
    expect(String(about[1][1])).toMatch(/"Group — N outlets" in all three columns/);
    expect(String(about[1][1])).not.toMatch(/all four columns/);
    expect(String(about[2][1])).not.toMatch(/no ASM in the reporting chain/);
    expect(String(about[2][1])).toMatch(/no active rep covering the outlet, no outlet assigned, or a blank outlet field/);
    expect(String(about[5][1])).toMatch(/vacant, inactive or removed/);
    expect(String(about[6][1])).toMatch(/When several reps cover an outlet, the n-th value in each ID column belongs to the same rep/);
    expect(String(about[6][1])).toMatch(/the covering rep has no level or sits above the ZH level/);
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
    // Employee ID rides on the SAME user read (nested salesUser select) — no per-row / extra salesUser query.
    expect(prisma.user.findMany.mock.calls[0][0]).toMatchObject({ select: { salesUser: { select: { employeeCode: true } } } });
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
    expect(events).toEqual(['audit', 'addSheet', 'row', 'addSheet', 'row', 'row', 'row', 'row', 'row', 'row', 'row']); // data sheet, then "About"
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

  describe('level ID columns (owner 2026-11-23)', () => {
    /** Installs for the Bajaj managers so each level has a row of their own. */
    const withManagers = (d: Tweak) => {
      for (const [id, role, code] of [
        ['u-so-x', 'SALES_SO', 'SO'], ['u-asm-x', 'SALES_ASM', 'ASM'], ['u-sm-x', 'SALES_STATE_HEAD', 'RSM'],
        ['u-zh-x', 'SALES_STATE_HEAD', 'ZNM'], ['u-nsm-x', 'SALES_HO', 'NSM'],
      ] as const) {
        d.users.push({
          id, clientId: 'bajaj', name: id, phone: '9111111111', role, status: 'ACTIVE', deletedAt: null,
          salesUser: { employeeCode: `own-${id}`, hierarchyLevel: { code, name: null } }, channelPartner: null,
        });
        d.installs.push({ userId: id, clientId: 'bajaj', platform: 'ANDROID', installedAt: D('2026-08-01T00:00:00Z'), lastSeenAt: null });
      }
    };
    const ids = (aoa: unknown[][], name: string) => {
      const r = aoa.find((x) => x[0] === name)!;
      return Array.from({ length: 5 }, (_, i) => r[8 + i] ?? null);
    };

    it('a sales user at each level: own code at own level, managers above, blank below; above rank 5 → all blank', async () => {
      const { aoa } = await build(CLIENT, { roleGroup: 'sales' }, makePrisma(withManagers));
      expect(ids(aoa, 'Ravi')).toEqual(['su-isr', 'su-so', 'su-asm', 'su-sm', 'su-zh']);
      expect(ids(aoa, 'u-so-x')).toEqual([null, 'su-so', 'su-asm', 'su-sm', 'su-zh']);
      expect(ids(aoa, 'u-asm-x')).toEqual([null, null, 'su-asm', 'su-sm', 'su-zh']);
      expect(ids(aoa, 'u-sm-x')).toEqual([null, null, null, 'su-sm', 'su-zh']);
      expect(ids(aoa, 'u-zh-x')).toEqual([null, null, null, null, 'su-zh']);
      expect(ids(aoa, 'u-nsm-x')).toEqual([null, null, null, null, null]); // NSM = rank 6 → no column
      // the existing Employee ID column is unchanged (the user read's own record)
      expect(aoa.find((x) => x[0] === 'u-nsm-x')![7]).toBe('own-u-nsm-x');
    }, XLSX_TIMEOUT);

    it('a vacant / inactive manager in the chain → "Vacant (code)"; a missing level above → "Not set"', async () => {
      const prisma = makePrisma((d) => {
        d.salesUsers.find((x) => x.id === 'su-asm')!.isActive = false; // vacant ASM
        d.salesUsers.find((x) => x.id === 'su-sm')!.reportingToId = null; // nobody at ZH above the SM
      });
      const { aoa } = await build(CLIENT, {}, prisma);
      expect(ids(aoa, 'Ravi')).toEqual(['su-isr', 'su-so', 'Vacant (su-asm)', 'su-sm', 'Not set']);
    }, XLSX_TIMEOUT);

    it('a retailer with ONE rep → that rep’s chain; with TWO reps → distinct codes joined " | " in sorted order', async () => {
      const one = await build(CLIENT, { roleGroup: 'partner' });
      expect(Array.from({ length: 5 }, (_, i) => one.aoa[1][8 + i])).toEqual(['su-isr', 'su-so', 'su-asm', 'su-sm', 'su-zh']);

      const two = await build(CLIENT, { roleGroup: 'partner' }, makePrisma((d) => {
        d.salesUsers.push(suRow('su-so2', 'bajaj', 'u-so2', 'SO', 'su-asm', 'Sona'), suRow('su-isr2', 'bajaj', 'u-isr2', 'XSR', 'su-so2', 'Ira'));
        d.assignments.push({ clientId: 'bajaj', salesUserId: 'su-isr2', outletId: null, partnerId: 'P-1' }); // owner route
      }));
      // Column-aligned: the n-th value in every column belongs to the same rep (shared managers repeat).
      expect(Array.from({ length: 5 }, (_, i) => two.aoa[1][8 + i])).toEqual([
        'su-isr | su-isr2', 'su-so | su-so2', 'su-asm | su-asm', 'su-sm | su-sm', 'su-zh | su-zh',
      ]);
    }, XLSX_TIMEOUT);

    const cells = (aoa: unknown[][]) => Array.from({ length: 5 }, (_, i) => aoa[1][8 + i] ?? null);

    it('pivot I1/S9 + I2/S1: each rep keeps its OWN SO in the same position (never sorted per column)', async () => {
      const { aoa } = await build(CLIENT, { roleGroup: 'partner' }, makePrisma((d) => {
        d.salesUsers.push(suRow('su-soZ', 'bajaj', 'u-soZ', 'SO', 'su-asm', 'Zed'), suRow('su-soA', 'bajaj', 'u-soA', 'SO', 'su-asm', 'Abe'));
        d.salesUsers.find((x) => x.id === 'su-isr')!.reportingToId = 'su-soZ'; // I1 → S9 ("su-soZ")
        d.salesUsers.push(suRow('su-isr2', 'bajaj', 'u-isr2', 'XSR', 'su-soA', 'Ira')); // I2 → S1 ("su-soA")
        d.assignments.push({ clientId: 'bajaj', salesUserId: 'su-isr2', outletId: 'o-ret', partnerId: null });
      }));
      expect(cells(aoa)).toEqual(['su-isr | su-isr2', 'su-soZ | su-soA', 'su-asm | su-asm', 'su-sm | su-sm', 'su-zh | su-zh']);
    }, XLSX_TIMEOUT);

    it('mixed SO rep + ISR rep: the SO rep holds its ISR slot with "Not set"; chains stay aligned', async () => {
      const { aoa } = await build(CLIENT, { roleGroup: 'partner' }, makePrisma((d) => {
        d.assignments.push({ clientId: 'bajaj', salesUserId: 'su-so', outletId: null, partnerId: 'P-1' }); // owner route
      }));
      expect(cells(aoa)).toEqual(['su-isr | Not set', 'su-so | su-so', 'su-asm | su-asm', 'su-sm | su-sm', 'su-zh | su-zh']);
    }, XLSX_TIMEOUT);

    it('identical chains from two routes collapse to one', async () => {
      const { aoa } = await build(CLIENT, { roleGroup: 'partner' }, makePrisma((d) => {
        d.assignments.push({ clientId: 'bajaj', salesUserId: 'su-isr', outletId: null, partnerId: 'P-1' });
      }));
      expect(cells(aoa)).toEqual(['su-isr', 'su-so', 'su-asm', 'su-sm', 'su-zh']);
    }, XLSX_TIMEOUT);

    it.each([
      ['a covering rep with NO level', ''],
      ['a covering rep ABOVE rank 5 (NSM)', 'NSM'],
    ])('%s → "Not set" in every level column (never an all-blank row)', async (_l, code) => {
      const { aoa } = await build(CLIENT, { roleGroup: 'partner' }, makePrisma((d) => {
        d.salesUsers.find((x) => x.id === 'su-isr')!.hierarchyLevel = { code };
      }));
      expect(cells(aoa)).toEqual(Array(5).fill('Not set'));
    }, XLSX_TIMEOUT);

    it('a retailer with no active rep → "Not set" in every level column', async () => {
      const { aoa } = await build(CLIENT, { roleGroup: 'partner' }, makePrisma((d) => {
        d.salesUsers.find((x) => x.id === 'su-isr')!.isActive = false;
      }));
      expect(Array.from({ length: 5 }, (_, i) => aoa[1][8 + i])).toEqual(Array(5).fill('Not set'));
    }, XLSX_TIMEOUT);

    it('header collision: a level named "Employee" never makes a second "Employee ID" column', () => {
      expect(installedUsersHeaders([
        { code: 'XSR', label: 'Employee' }, { code: 'SO', label: 'SO' }, { code: 'ASM', label: 'SO' },
      ]).slice(7, 11)).toEqual(['Employee ID', 'Employee ID (XSR)', 'SO ID', 'SO ID (ASM)']);
    });

    it('2,000 rows with level IDs: still ONE read each of levels / sales users / assignments / outlets', async () => {
      const prisma = makePrisma();
      const many = Array.from({ length: 2_000 }, (_, i) => ({ userId: `bulk-${i}`, _min: { installedAt: D('2026-11-01T00:00:00Z') }, _max: { lastSeenAt: null } }));
      prisma.pwaInstall.groupBy.mockResolvedValueOnce(many as never);
      prisma.user.findMany.mockImplementation((async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, name: id, phone: '9000000000', role: 'WHOLESALER', status: 'ACTIVE', salesUser: null, channelPartner: null }))) as never);
      const { rowCount } = await build(CLIENT, {}, prisma);
      expect(rowCount).toBe(2_000);
      for (const m of [prisma.salesHierarchyLevel, prisma.salesUser, prisma.salesUserAssignment, prisma.outlet]) {
        expect(m.findMany).toHaveBeenCalledTimes(1);
      }
    }, XLSX_TIMEOUT);
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
      // Owner 2026-11-24: Gifsy staff roles (e.g. Project Manager) reach App Adoption via 'Reporting & Analytics → view'.
      expect(reflector.get(PERMISSION_KEY, proto.getAdoption)).toBe('reports:read');
      expect(reflector.get(PERMISSION_KEY, proto.installedUsers)).toBe('reports:read');
      expect(APP_INSTALLED_USERS_KIND.access.permission).toBe('reports:read');
    });

    it('a Gifsy staff role WITH reports:read is allowed; WITHOUT it is refused (endpoint and export kind alike)', async () => {
      const staffAccess = new ExportAccessChecker(
        { getPermissions: async (id?: string | null) => new Set(id === 'pm-role' ? ['reports:read'] : []) } as unknown as GifsyRoleService,
        { isFeatureEnabled: async () => false } as unknown as TenantService,
      );
      const pm = { ...CLIENT, role: 'GIFSY_STAFF', gifsyRoleId: 'pm-role' } as JwtPayload;
      const noPerm = { ...CLIENT, role: 'GIFSY_STAFF', gifsyRoleId: 'other-role' } as JwtPayload;
      await expect(staffAccess.assert(pm, APP_INSTALLED_USERS_KIND.access)).resolves.toBeUndefined();
      await expect(staffAccess.assert(noPerm, APP_INSTALLED_USERS_KIND.access)).rejects.toBeInstanceOf(ForbiddenException);
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
