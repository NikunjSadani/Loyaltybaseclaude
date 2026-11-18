import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildUsageReport,
  pageOfUsageReport,
  resolveUsageParams,
  usageAggregateSql,
  USAGE_DURATION_NOTE,
  type UsageParams,
} from './usage-report';
import { ReportsService } from '../reports.service';
import { USAGE_REPORT_HEADERS, USAGE_REPORT_KIND, USAGE_REPORT_NONE_MESSAGE } from '../../exports/kinds/batch2/usage-report.kind';
import { startPgliteTestDb, type PgliteTestDb } from '../../common/testing/pglite-testkit-spec';

// 2026-11-20 12:00 IST
const NOW = new Date('2026-11-20T06:30:00.000Z');

const params = (over: Partial<UsageParams> = {}): UsageParams => ({
  from: '2026-11-01',
  to: '2026-11-30',
  role: null,
  program: null,
  region: null,
  sort: 'minutes',
  includeInactive: false,
  page: 1,
  pageSize: 50,
  ...over,
});

// ─── Fixtures: two tenants. Every read in the fake honours the clientId it is given. ───────────────────────────
interface Agg {
  userId: string;
  daysActive: number;
  trackedDays: number;
  visits: number;
  activeSeconds: number;
  appDays: number;
  browserDays: number;
  phoneDays: number;
  computerDays: number;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}
const agg = (userId: string, o: Partial<Agg> = {}): Agg => ({
  userId,
  daysActive: 1,
  trackedDays: 1,
  visits: 1,
  activeSeconds: 600,
  appDays: 0,
  browserDays: 0,
  phoneDays: 0,
  computerDays: 0,
  firstSeenAt: new Date('2026-11-10T04:00:00Z'),
  lastSeenAt: new Date('2026-11-10T05:00:00Z'),
  ...o,
});

function fixtures() {
  const users = [
    { id: 'r1', clientId: 'bajaj', name: 'Asha Retail', phone: '919876500001', role: 'SSS', status: 'ACTIVE', salesUser: null },
    { id: 'r2', clientId: 'bajaj', name: 'Bala Retail', phone: '919876500002', role: 'SSS', status: 'ACTIVE', salesUser: null },
    { id: 'p1', clientId: 'bajaj', name: 'Parent Owner', phone: '919876500003', role: 'WHOLESALER', status: 'ACTIVE', salesUser: null },
    { id: 's1', clientId: 'bajaj', name: 'Sunil SO', phone: '919876500004', role: 'SALES_SO', status: 'ACTIVE', salesUser: { region: null, zone: null } },
    { id: 's2', clientId: 'bajaj', name: 'Zara ASM', phone: '919876500005', role: 'SALES_ASM', status: 'ACTIVE', salesUser: { region: 'West', zone: null } },
    { id: 'a1', clientId: 'bajaj', name: 'Client Admin', phone: '919876500006', role: 'CLIENT_ADMIN', status: 'ACTIVE', salesUser: null },
    { id: 'idle', clientId: 'bajaj', name: 'Idle Retail', phone: '919876500007', role: 'SSS', status: 'INACTIVE', salesUser: null },
    // other tenant — must NEVER appear in a bajaj report
    { id: 'd1', clientId: 'deoleo', name: 'Deoleo Retail', phone: '919800000001', role: 'SSS', status: 'ACTIVE', salesUser: null },
  ];
  const outlets = [
    { clientId: 'bajaj', programName: ' Gold ', state: 'Maharashtra', partner: { userId: 'r1' }, parent: null },
    { clientId: 'bajaj', programName: 'Silver', state: 'Gujarat', partner: { userId: 'r2' }, parent: { userId: 'p1' } },
    { clientId: 'bajaj', programName: 'Gold', state: 'Gujarat', partner: { userId: 'idle' }, parent: null },
    { clientId: 'bajaj', programName: null, state: 'Goa', partner: null, parent: null },
    { clientId: 'deoleo', programName: 'Deoleo Club', state: 'Kerala', partner: { userId: 'd1' }, parent: null },
  ];
  const assignments = [
    {
      salesUser: { userId: 's1', clientId: 'bajaj' },
      outlet: { programName: 'Gold', state: 'Maharashtra', deletedAt: null, clientId: 'bajaj' },
      partner: null,
    },
    {
      salesUser: { userId: 's2', clientId: 'bajaj' },
      outlet: { programName: 'Silver', state: 'Gujarat', deletedAt: null, clientId: 'bajaj' },
      partner: null,
    },
  ];
  const activity: Agg[] = [
    agg('r1', { daysActive: 5, trackedDays: 4, visits: 7, activeSeconds: 3_000, appDays: 4, phoneDays: 4, lastSeenAt: new Date('2026-11-19T10:00:00Z') }),
    agg('r2', { daysActive: 2, trackedDays: 2, visits: 2, activeSeconds: 120, browserDays: 2, computerDays: 1, phoneDays: 1 }),
    agg('s1', { daysActive: 9, trackedDays: 9, visits: 12, activeSeconds: 1_200, appDays: 3, browserDays: 6, phoneDays: 9, lastSeenAt: new Date('2026-11-20T03:00:00Z') }),
    agg('a1', { daysActive: 3, trackedDays: 0, visits: 0, activeSeconds: 0 }), // legacy-only days (pre-ship)
    agg('d1', { daysActive: 30, trackedDays: 30, visits: 90, activeSeconds: 99_999, appDays: 30 }),
  ];
  return { users, outlets, assignments, activity, started: '2026-11-18' };
}

function fakePrisma(fx = fixtures()) {
  const usersOf = (clientId: string) => new Set(fx.users.filter((u) => u.clientId === clientId).map((u) => u.id));
  return {
    fx,
    user: {
      findMany: jest.fn(async ({ where }: any) => fx.users.filter((u) => u.clientId === where.clientId)),
    },
    outlet: {
      findMany: jest.fn(async ({ where }: any) => fx.outlets.filter((o) => o.clientId === where.clientId)),
    },
    salesUserAssignment: {
      findMany: jest.fn(async ({ where }: any) =>
        fx.assignments.filter((a) => a.salesUser.clientId === where.salesUser.clientId),
      ),
    },
    $queryRaw: jest.fn(async (sql: any) => {
      if (String(sql.text).includes('GROUP BY')) {
        const ids = usersOf(sql.values[0]);
        return fx.activity.filter((a) => ids.has(a.userId));
      }
      return [{ day: sql.values[0] === 'bajaj' ? fx.started : null }];
    }),
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

// ─── Params ─────────────────────────────────────────────────────────────────────────────────────────────────
describe('resolveUsageParams', () => {
  it('defaults to the last 30 IST days ending today, minutes sort, active users only, page 1 × 50', () => {
    expect(resolveUsageParams({}, NOW)).toEqual({
      from: '2026-10-22',
      to: '2026-11-20',
      role: null,
      program: null,
      region: null,
      sort: 'minutes',
      includeInactive: false,
      page: 1,
      pageSize: 50,
    });
  });

  it('IST "today" rolls at 18:30Z', () => {
    expect(resolveUsageParams({}, new Date('2026-11-20T18:31:00Z')).to).toBe('2026-11-21');
  });

  it('accepts up to 366 days inclusive; refuses 367', () => {
    expect(resolveUsageParams({ from: '2025-11-20', to: '2026-11-20' }, NOW).from).toBe('2025-11-20'); // 366 days
    expect(() => resolveUsageParams({ from: '2025-11-19', to: '2026-11-20' }, NOW)).toThrow(BadRequestException);
  });

  it('refuses from > to and impossible calendar dates', () => {
    expect(() => resolveUsageParams({ from: '2026-11-21', to: '2026-11-20' }, NOW)).toThrow(BadRequestException);
    expect(() => resolveUsageParams({ from: '2026-02-30', to: '2026-03-02' }, NOW)).toThrow(BadRequestException);
    expect(() => resolveUsageParams({ to: '2026-13-01' }, NOW)).toThrow(BadRequestException);
  });

  it('trims programme / region; blank = no filter; includeInactive only on "true"', () => {
    const p = resolveUsageParams({ program: '  Gold ', region: '   ', includeInactive: 'true', sort: 'days' }, NOW);
    expect(p).toMatchObject({ program: 'Gold', region: null, includeInactive: true, sort: 'days' });
    expect(resolveUsageParams({ includeInactive: 'false' }, NOW).includeInactive).toBe(false);
  });
});

// ─── Build ──────────────────────────────────────────────────────────────────────────────────────────────────
describe('buildUsageReport', () => {
  it('TENANT ISOLATION: every read is pinned to the caller tenant; another tenant never appears', async () => {
    const prisma = fakePrisma();
    const r = await buildUsageReport(prisma as any, 'bajaj', params({ includeInactive: true }), NOW);
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ clientId: 'bajaj', deletedAt: null });
    expect(prisma.outlet.findMany.mock.calls[0][0].where).toEqual({ clientId: 'bajaj', deletedAt: null });
    expect(prisma.salesUserAssignment.findMany.mock.calls[0][0].where.salesUser).toEqual({ clientId: 'bajaj', deletedAt: null });
    for (const call of prisma.$queryRaw.mock.calls) expect(call[0].values[0]).toBe('bajaj');
    expect(r.rows.map((x) => x.userId)).not.toContain('d1');
    expect(r.filters.programs).not.toContain('Deoleo Club');
    expect(r.filters.regions).not.toContain('Kerala');
    expect(r.totals.totalMinutes).toBe(Math.floor((3_000 + 120 + 1_200) / 60)); // 72 — not Deoleo's 99,999 s
  });

  it('refuses a missing tenant (403) before any read', async () => {
    const prisma = fakePrisma();
    await expect(buildUsageReport(prisma as any, '  ', params(), NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('totals over the filtered population: active users, avg days, minutes, app/browser, phone/computer', async () => {
    const r = await buildUsageReport(fakePrisma() as any, 'bajaj', params(), NOW);
    expect(r.totals).toEqual({
      usersInScope: 7,
      usersActive: 4, // r1, r2, s1, a1
      usersInactive: 3, // p1, s2, idle
      avgDaysActive: Math.round(((5 + 2 + 9 + 3) / 4) * 10) / 10, // 4.8
      totalMinutes: 72,
      avgMinutesPerActiveUser: Math.round(((3_000 + 120 + 1_200) / 60 / 4) * 10) / 10, // 18
      appUsers: 2, // r1, s1
      browserUsers: 2, // r2, s1
      phoneUsers: 3, // r1, r2, s1
      computerUsers: 1, // r2
    });
    expect(r.range).toEqual({ from: '2026-11-01', to: '2026-11-30', days: 30 });
    expect(r.trackingStartedOn).toBe('2026-11-18');
    expect(r.notes.duration).toBe(USAGE_DURATION_NOTE);
  });

  it('default lists ACTIVE users only; the "show inactive users" toggle adds who did NOT use it', async () => {
    const prisma = fakePrisma();
    const active = await buildUsageReport(prisma as any, 'bajaj', params(), NOW);
    expect(active.rows.map((x) => x.userId).sort()).toEqual(['a1', 'r1', 'r2', 's1']);
    const all = await buildUsageReport(prisma as any, 'bajaj', params({ includeInactive: true }), NOW);
    expect(all.rows).toHaveLength(7);
    const idle = all.rows.find((x) => x.userId === 'idle')!;
    expect(idle).toMatchObject({ daysActive: 0, visits: 0, minutes: 0, avgMinutesPerDay: null, device: '', lastSeenAt: null });
    expect(all.totals).toEqual(active.totals); // the toggle changes the list, never the totals
  });

  it('row maths: minutes floor, avg per TRACKED day (legacy days excluded), device label, ISO times', async () => {
    const r = await buildUsageReport(fakePrisma() as any, 'bajaj', params(), NOW);
    const by = new Map(r.rows.map((x) => [x.userId, x]));
    expect(by.get('r1')).toMatchObject({ minutes: 50, avgMinutesPerDay: 12.5, device: 'Phone', appDays: 4, visits: 7 });
    expect(by.get('r2')).toMatchObject({ minutes: 2, avgMinutesPerDay: 1, device: 'Both' });
    expect(by.get('a1')).toMatchObject({ daysActive: 3, trackedDays: 0, minutes: 0, avgMinutesPerDay: null, device: '' });
    expect(by.get('r1')!.lastSeenAt).toBe('2026-11-19T10:00:00.000Z');
  });

  it('programme / region: own outlets (trimmed), group parent, sales assignments, employee-record region wins', async () => {
    const r = await buildUsageReport(fakePrisma() as any, 'bajaj', params({ includeInactive: true }), NOW);
    const by = new Map(r.rows.map((x) => [x.userId, x]));
    expect(by.get('r1')).toMatchObject({ programmes: ['Gold'], regions: ['Maharashtra'] });
    expect(by.get('p1')).toMatchObject({ programmes: ['Silver'], regions: ['Gujarat'] }); // heads r2's outlet group
    expect(by.get('s1')).toMatchObject({ programmes: ['Gold'], regions: ['Maharashtra'] }); // directly-assigned outlet
    expect(by.get('s2')).toMatchObject({ programmes: ['Silver'], regions: ['West'] }); // SalesUser.region overrides
    expect(by.get('a1')).toMatchObject({ programmes: [], regions: [] });
    expect(r.filters.programs).toEqual(['Gold', 'Silver']);
    expect(r.filters.regions).toEqual(['Goa', 'Gujarat', 'Maharashtra', 'West']);
    expect(r.filters.roles).toEqual(['CLIENT_ADMIN', 'SALES_ASM', 'SALES_SO', 'SSS', 'WHOLESALER']);
  });

  it('filters: role, programme (case-insensitive), region — totals follow the filter', async () => {
    const prisma = fakePrisma();
    const sss = await buildUsageReport(prisma as any, 'bajaj', params({ role: 'SSS', includeInactive: true }), NOW);
    expect(sss.rows.map((x) => x.userId).sort()).toEqual(['idle', 'r1', 'r2']);
    expect(sss.totals.usersInScope).toBe(3);

    const gold = await buildUsageReport(prisma as any, 'bajaj', params({ program: 'gold', includeInactive: true }), NOW);
    expect(gold.rows.map((x) => x.userId).sort()).toEqual(['idle', 'r1', 's1']);
    expect(gold.totals.totalMinutes).toBe(Math.floor((3_000 + 1_200) / 60));

    const guj = await buildUsageReport(prisma as any, 'bajaj', params({ region: 'GUJARAT' }), NOW);
    expect(guj.rows.map((x) => x.userId)).toEqual(['r2']); // p1 / idle are inactive → hidden by default

    const none = await buildUsageReport(prisma as any, 'bajaj', params({ program: 'Platinum' }), NOW);
    expect(none.rows).toEqual([]);
    expect(none.totals.usersInScope).toBe(0);
    expect(none.totals.avgDaysActive).toBeNull();
  });

  it('sorts by minutes (default) / days / last seen / name', async () => {
    const prisma = fakePrisma();
    const ids = async (sort: UsageParams['sort']) =>
      (await buildUsageReport(prisma as any, 'bajaj', params({ sort }), NOW)).rows.map((x) => x.userId);
    expect(await ids('minutes')).toEqual(['r1', 's1', 'r2', 'a1']);
    expect(await ids('days')).toEqual(['s1', 'r1', 'a1', 'r2']);
    expect(await ids('lastSeen')).toEqual(['s1', 'r1', 'r2', 'a1']); // r2/a1 tie on lastSeen → by name (Bala < Client)
    expect(await ids('name')).toEqual(['r1', 'r2', 'a1', 's1']);
  });

  it('pagination slices the sorted rows; out-of-range pages clamp; totals are for ALL rows', async () => {
    const r = await buildUsageReport(fakePrisma() as any, 'bajaj', params({ includeInactive: true }), NOW);
    const p2 = pageOfUsageReport(r, params({ includeInactive: true, page: 2, pageSize: 3 }));
    expect(p2).toMatchObject({ page: 2, pageSize: 3, pageCount: 3, totalRows: 7 });
    expect(p2.rows.map((x) => x.userId)).toEqual(r.rows.slice(3, 6).map((x) => x.userId));
    expect(p2.totals).toEqual(r.totals);
    expect(pageOfUsageReport(r, params({ page: 99, pageSize: 3 })).page).toBe(3);
  });

  it('scale: 9,000 users build in one pass (no per-user query)', async () => {
    const fx = fixtures();
    for (let i = 0; i < 9_000; i++) {
      fx.users.push({ id: `bulk${i}`, clientId: 'bajaj', name: `User ${i}`, phone: '9', role: 'SSS', status: 'ACTIVE', salesUser: null });
      if (i % 2) fx.activity.push(agg(`bulk${i}`, { activeSeconds: i }));
    }
    const prisma = fakePrisma(fx);
    const r = await buildUsageReport(prisma as any, 'bajaj', params({ includeInactive: true }), NOW);
    expect(r.rows).toHaveLength(9_007);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});

// ─── The aggregate SQL against a REAL Postgres (PGlite) ─────────────────────────────────────────────────────
describe('usageAggregateSql — real Postgres', () => {
  let db: PgliteTestDb;
  const MIG = join(__dirname, '..', '..', '..', 'prisma', 'migrations');

  beforeAll(async () => {
    db = startPgliteTestDb();
    await db.exec(`CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "deletedAt" TIMESTAMP(3))`);
    await db.exec(readFileSync(join(MIG, '20260630120000_add_user_activity_day', 'migration.sql'), 'utf8'));
    await db.exec(readFileSync(join(MIG, '20261118190000_user_activity_usage', 'migration.sql'), 'utf8'));
    await db.exec(`
      INSERT INTO "users" VALUES ('u1','bajaj',NULL), ('u2','bajaj',NULL), ('gone','bajaj','2026-11-01'), ('x1','deoleo',NULL);
      INSERT INTO "user_activity_day"
        ("id","userId","clientId","activityDate","firstSeenAt","lastSeenAt","updatedAt","visits","activeSeconds","appUsed","browserUsed","phoneUsed","computerUsed")
      VALUES
        ('1','u1','bajaj','2026-10-31','2026-10-31 04:00','2026-10-31 05:00',now(), 2, 900, true, false, true, false),  -- before range
        ('2','u1','bajaj','2026-11-01','2026-11-01 04:00','2026-11-01 05:00',now(), 2, 600, true, false, true, false),  -- first day
        ('3','u1','bajaj','2026-11-15','2026-11-15 04:00','2026-11-15 09:00',now(), 1, 300, false, true, false, true),
        ('4','u1','bajaj','2026-11-30','2026-11-30 04:00','2026-11-30 06:00',now(), 0, 0, false, false, false, false), -- last day, legacy
        ('5','u1','bajaj','2026-12-01','2026-12-01 04:00','2026-12-01 05:00',now(), 1, 60, true, false, true, false),  -- after range
        ('6','u2','gifsy','2026-11-10','2026-11-10 04:00','2026-11-10 04:30',now(), 1, 120, false, true, false, true), -- stamped under another context, still u2
        ('7','gone','bajaj','2026-11-10','2026-11-10 04:00','2026-11-10 04:30',now(), 1, 999, true, false, true, false),
        ('8','x1','deoleo','2026-11-10','2026-11-10 04:00','2026-11-10 04:30',now(), 5, 5000, true, false, true, false);
    `);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('per-user sums inside the inclusive IST range; other tenants and deleted users excluded', async () => {
    const sql = usageAggregateSql('bajaj', '2026-11-01', '2026-11-30');
    const rows = await db.query<any>(sql.text, sql.values as unknown[]);
    const by = new Map(rows.map((r) => [r.userId, r]));
    expect([...by.keys()].sort()).toEqual(['u1', 'u2']);
    expect(by.get('u1')).toMatchObject({
      daysActive: 3,
      trackedDays: 2,
      visits: 3,
      activeSeconds: 900,
      appDays: 1,
      browserDays: 1,
      phoneDays: 1,
      computerDays: 1,
    });
    expect(by.get('u2')).toMatchObject({ daysActive: 1, activeSeconds: 120, browserDays: 1, computerDays: 1 });
  });
});

// ─── Service + Excel kind ───────────────────────────────────────────────────────────────────────────────────
describe('ReportsService.usageReport', () => {
  it('returns one page + totals for the caller tenant (JSON)', async () => {
    const prisma = fakePrisma();
    const svc = new ReportsService(prisma as any, {} as any);
    const res: any = await svc.usageReport({ sub: 'u', role: 'CLIENT_ADMIN', clientId: 'bajaj' } as any, {
      from: '2026-11-01',
      to: '2026-11-30',
      pageSize: 2,
    });
    expect(res.kind).toBe('json');
    expect(res.data).toMatchObject({ page: 1, pageSize: 2, totalRows: 4, pageCount: 2 });
    expect(res.data.rows).toHaveLength(2);
    expect(res.data.totals.usersActive).toBe(4);
  });
});

describe("export kind 'usage-report'", () => {
  const user = { sub: 'admin-1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'A' } as any;

  function writer() {
    const rows: unknown[][] = [];
    const sheets: Array<{ name: string; headers: readonly string[] }> = [];
    return {
      rows,
      sheets,
      out: {
        addSheet: jest.fn(async (name: string, headers: readonly string[]) => {
          sheets.push({ name, headers });
          return { addRow: async (r: unknown[]) => void rows.push(r) };
        }),
        finish: jest.fn(),
      } as any,
    };
  }

  it('access = Session Report access; light (always streams)', () => {
    expect(USAGE_REPORT_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN'], permission: 'reports:read' });
    expect(USAGE_REPORT_KIND.isHeavy(params())).toBe(false);
  });

  it('parses the same query the endpoint takes; rejects junk; refuses a tenant-less caller', () => {
    const p = USAGE_REPORT_KIND.parseParams({ from: '2026-11-01', to: '2026-11-30', role: 'SSS', format: 'xlsx', includeInactive: 'true' }, user);
    expect(p).toMatchObject({ from: '2026-11-01', to: '2026-11-30', role: 'SSS', includeInactive: true });
    expect(() => USAGE_REPORT_KIND.parseParams({ role: 'KING' }, user)).toThrow(BadRequestException);
    expect(() => USAGE_REPORT_KIND.parseParams({ sneaky: '1' }, user)).toThrow(BadRequestException);
    expect(() => USAGE_REPORT_KIND.parseParams({}, { ...user, clientId: '' })).toThrow(ForbiddenException);
    expect(USAGE_REPORT_KIND.describeParams(p)).toBe('2026-11-01 to 2026-11-30 · SSS · incl. inactive users');
    expect(USAGE_REPORT_KIND.fileName(p, NOW)).toBe('usage-report-2026-11-01-to-2026-11-30.xlsx');
  });

  it('writes EVERY filtered row (not a page), audit BEFORE the sheet, last-10-digit phones', async () => {
    const prisma = fakePrisma();
    const order: string[] = [];
    prisma.auditLog.create.mockImplementation(async () => void order.push('audit'));
    const w = writer();
    w.out.addSheet.mockImplementation(async (name: string, headers: readonly string[]) => {
      order.push('sheet');
      w.sheets.push({ name, headers });
      return { addRow: async (r: unknown[]) => void w.rows.push(r) };
    });
    const ctx = { prisma, user, clientId: 'bajaj', now: NOW, moduleRef: {} } as any;
    const res = await USAGE_REPORT_KIND.run(ctx, params({ includeInactive: true, pageSize: 2 }), w.out);
    expect(res.rowCount).toBe(7);
    expect(w.rows).toHaveLength(7);
    expect(order).toEqual(['audit', 'sheet']);
    expect(w.sheets[0].headers).toEqual([...USAGE_REPORT_HEADERS]);
    const audit = prisma.auditLog.create.mock.calls[0][0].data;
    expect(audit).toMatchObject({ action: 'EXPORT', entityType: 'USAGE_REPORT', entityId: 'bajaj', actorId: 'admin-1' });
    expect(audit.metadata).toMatchObject({ rowCount: 7, filters: { includeInactive: true } });
    const first = w.rows[0];
    expect(first[0]).toBe('Asha Retail');
    expect(first[1]).toBe('9876500001');
    expect(first[8]).toBe(50); // minutes
    expect(w.rows.map((r) => r[0])).not.toContain('Deoleo Retail');
  });

  it('0 matching users → 404 with the plain message, no audit row, no sheet', async () => {
    const prisma = fakePrisma();
    const w = writer();
    const ctx = { prisma, user, clientId: 'bajaj', now: NOW, moduleRef: {} } as any;
    await expect(USAGE_REPORT_KIND.run(ctx, params({ program: 'Platinum' }), w.out)).rejects.toThrow(
      new NotFoundException(USAGE_REPORT_NONE_MESSAGE),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(w.out.addSheet).not.toHaveBeenCalled();
  });
});
