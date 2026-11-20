/**
 * Unit tests for visibility-report.service.ts — the MONTH-WISE report (VISIBILITY-POSM-DESIGN.md §17).
 *
 * Fixture: 5 in-scope outlets; o1 APPROVED by an IMPORTED old-app row (no submitter), o2 SUBMITTED (portal),
 * o3 CHANGES_REQUESTED, o4 REJECTED, o5 no capture. Portal go-live defaults to 2026-01 (no imported month). Rep r1 (o1,o2) reports to an INACTIVE m1 who reports to m2
 * (→ first active manager = m2); rep r2 (o3); o4/o5 unassigned. Clock pinned to 2026-11-20 IST, so 2026-10 is a
 * CLOSED window (o5 → Missed) and 2026-11 is OPEN (o5 → Not captured yet).
 *
 * Run: npx jest src/visibility/visibility-report.service.spec.ts
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  VisibilityReportService, tallySlots, breakdown, groupKeyOf, IMPORTED_LABEL, ReportSlot, reviewerOfCapture,
} from './visibility-report.service';
import { PrismaService } from '../prisma/prisma.service';
import { clearVisibilityGoLiveCache } from './visibility-portal-go-live';
import { visibilityUniverseWhere } from './visibility-scope.helper';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { JwtPayload } from '../common/decorators/current-user.decorator';

const gifsy: JwtPayload = { sub: 'admin1', role: 'GIFSY_ADMIN', clientId: 't1', phone: '9', name: 'Admin' };
const clientAdmin: JwtPayload = { sub: 'ca1', role: 'CLIENT_ADMIN', clientId: 't1', phone: '9', name: 'CA' };

const baseConfig = {
  outletScope: ['SSS'],
  frequencyPerMonth: 1,
  allowedSalesLevels: ['SO'],
  geoFence: { enabled: true, radiusMeters: 50 },
  programs: [] as string[],
  subPrograms: [] as string[],
};

const OUTLETS = [
  { id: 'o1', outletCode: 'A1', name: 'One', programName: 'Unnati', programCategory: 'Elite' },
  { id: 'o2', outletCode: 'A2', name: 'Two', programName: 'Unnati', programCategory: 'Elite' },
  { id: 'o3', outletCode: 'A3', name: 'Three', programName: 'Unnati', programCategory: 'Privilege' },
  { id: 'o4', outletCode: 'A4', name: 'Four', programName: 'SAMT', programCategory: null },
  { id: 'o5', outletCode: 'A5', name: 'Five', programName: null, programCategory: null },
];

function capturesFor(month: string, window = 'P1') {
  const wk = `${month}-${window}`;
  return [
    // Imported old-app record (Bajaj migration shape): APPROVED, no submitter, approvedBy = a Gifsy admin.
    { id: 'c1', outletId: 'o1', windowKey: wk, status: 'APPROVED', capturedAt: null, receivedAt: new Date('2026-10-05T05:00:00Z'),
      reviewedAt: new Date('2026-10-06T05:00:00Z'), photoReviews: null, approvedByUserId: 'gadmin', submittedBySalesUserId: null, submittedBy: null,
      formValues: { w1: `visibility-media/bajaj/vendor-import/prod/run/A1/${month}_v1.jpg` } },
    { id: 'c2', outletId: 'o2', windowKey: wk, status: 'SUBMITTED', capturedAt: new Date('2026-10-07T05:00:00Z'), receivedAt: new Date('2026-10-07T05:00:00Z'),
      reviewedAt: null, photoReviews: null, approvedByUserId: null, submittedBySalesUserId: 'r1', submittedBy: { employeeCode: 'E1', user: { name: 'Ravi' } },
      formValues: { w1: { key: 'visibility-media/bajaj/A2/w1.jpg' } } },
    { id: 'c3', outletId: 'o3', windowKey: wk, status: 'CHANGES_REQUESTED', capturedAt: new Date('2026-10-08T05:00:00Z'), receivedAt: new Date('2026-10-08T05:00:00Z'),
      reviewedAt: new Date('2026-10-09T05:00:00Z'),
      photoReviews: { f1: { status: 'REJECTED', reasonCode: 'BLURRY', reviewedAt: '2026-10-09T05:00:00.000Z', reviewedByUserId: 'rev1' } },
      approvedByUserId: null, submittedBySalesUserId: 'r2', submittedBy: { employeeCode: 'E2', user: { name: 'Sita' } },
      formValues: { f1: { key: 'visibility-media/bajaj/A3/f1.jpg' } } },
    { id: 'c4', outletId: 'o4', windowKey: wk, status: 'REJECTED', capturedAt: null, receivedAt: new Date('2026-10-10T05:00:00Z'),
      reviewedAt: new Date('2026-10-11T05:00:00Z'), photoReviews: null, approvedByUserId: 'rev1', submittedBySalesUserId: 'r2', submittedBy: { employeeCode: 'E2', user: { name: 'Sita' } } as { employeeCode: string; user: { name: string } } | null,
      formValues: { w1: { key: 'visibility-media/bajaj/A4/w1.jpg' } } },
  ];
}

const mockPrisma = {
  outlet: { findMany: jest.fn() },
  visibilityCapture: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
  // visibility-portal-go-live: MIN(receivedAt) go-live + the windows holding imported captures.
  $queryRaw: jest.fn(),
  salesUserAssignment: { findMany: jest.fn() },
  salesUser: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
};
const mockTenant = { resolveVisibilityEnabled: jest.fn() };
const mockSettings = { getEffectiveSettings: jest.fn() };

function wireFixture(
  opts: { config?: Record<string, unknown>; goLive?: string | Date | null; importedWindows?: string[] } = {},
) {
  mockSettings.getEffectiveSettings.mockResolvedValue({ visibilityConfig: { ...baseConfig, ...(opts.config ?? {}) } });
  // Portal go-live instant (earliest non-imported capture): a `YYYY-MM` = the first instant of that IST month. By
  // default long before the fixture months → nothing is old-app history.
  const g = opts.goLive === undefined ? '2026-01' : opts.goLive;
  const goLiveAt = g === null ? null : g instanceof Date ? g : new Date(`${g}-01T00:00:00+05:30`);
  const importedWindows = opts.importedWindows ?? [];
  clearVisibilityGoLiveCache(); // go-live is cached per tenant — each fixture sets its own
  mockPrisma.$queryRaw.mockImplementation((q: { sql: string; values: unknown[] }) => {
    if (q.sql.includes('MIN("receivedAt")')) return Promise.resolve([{ goLive: goLiveAt }]);
    // importedWindowKeys: DISTINCT windowKey among the asked keys holding a /vendor-import/ photo.
    return Promise.resolve(importedWindows.filter((w) => q.values.includes(w)).map((windowKey) => ({ windowKey })));
  });
  mockPrisma.outlet.findMany.mockResolvedValue(OUTLETS);
  mockPrisma.visibilityCapture.findMany.mockImplementation(({ where }: any) => {
    const keys: string[] = where.windowKey.in;
    const month = keys[0].slice(0, 7);
    return Promise.resolve(capturesFor(month).filter((c) => keys.includes(c.windowKey)));
  });
  // NOT-in-scope count → 2; other-window (notIn) count → 1.
  mockPrisma.visibilityCapture.count.mockImplementation(({ where }: any) =>
    Promise.resolve(where.NOT ? 2 : where.windowKey?.notIn ? 1 : 0),
  );
  mockPrisma.salesUserAssignment.findMany.mockResolvedValue([
    { outletId: 'o1', salesUserId: 'r1' },
    { outletId: 'o2', salesUserId: 'r1' },
    { outletId: 'o3', salesUserId: 'r2' },
  ]);
  mockPrisma.salesUser.findMany.mockImplementation(({ where }: any) => {
    if (where.id) {
      const names: Record<string, { name: string; code: string }> = {
        r1: { name: 'Ravi', code: 'E1' }, r2: { name: 'Sita', code: 'E2' }, m2: { name: 'Meera', code: 'M2' },
      };
      return Promise.resolve(
        (where.id.in as string[]).filter((id) => names[id]).map((id) => ({ id, employeeCode: names[id].code, user: { name: names[id].name } })),
      );
    }
    // Hierarchy: r1 → m1 (INACTIVE, vacant) → m2 (active). r2 → m2.
    return Promise.resolve([
      { id: 'r1', reportingToId: 'm1', userId: 'u-r1', isActive: true, deletedAt: null },
      { id: 'r2', reportingToId: 'm2', userId: 'u-r2', isActive: true, deletedAt: null },
      { id: 'm1', reportingToId: 'm2', userId: 'u-m1', isActive: false, deletedAt: null },
      { id: 'm2', reportingToId: null, userId: 'u-m2', isActive: true, deletedAt: null },
    ]);
  });
  mockPrisma.user.findMany.mockResolvedValue([
    { id: 'gadmin', name: 'Gifsy Admin' },
    { id: 'rev1', name: 'Reviewer One' },
  ]);
}

describe('VisibilityReportService (month-wise)', () => {
  let service: VisibilityReportService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: new Date('2026-11-20T06:30:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(true);
    wireFixture();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VisibilityReportService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TenantService, useValue: mockTenant },
        { provide: TenantSettingsService, useValue: mockSettings },
      ],
    }).compile();
    service = module.get(VisibilityReportService);
  });

  afterEach(() => jest.useRealTimers());

  it('closed month: re-take / rejected left at window close = Not approved — window closed; no capture = Missed', async () => {
    const res = await service.gifsyReport(gifsy, { month: '2026-10' });
    expect(res.month).toBe('2026-10');
    expect(res.windowKey).toBeNull();
    expect(res.windows).toEqual([{ key: '2026-10-P1', closed: true }]);
    expect(res.importedMonth).toBe(false);
    expect(res.summary).toMatchObject({
      inScope: 5, approved: 1, waiting: 1, needsRetake: 0, rejected: 0, closedNotApproved: 2, notCaptured: 0, missed: 1,
      notTracked: 0, coveragePct: 20,
    });
    const closed = await service.gifsyOutlets(gifsy, { month: '2026-10', status: 'CLOSED_NOT_APPROVED' });
    expect(closed.rows.map((r) => r.outletCode)).toEqual(['A3', 'A4']);
  });

  it('open window: re-take / rejected are still waiting on reps (Needs re-take / Rejected)', async () => {
    const res = await service.gifsyReport(gifsy, { month: '2026-11' });
    expect(res.summary).toMatchObject({ needsRetake: 1, rejected: 1, closedNotApproved: 0 });
  });

  it('open month (default = current IST month): no capture yet = Not captured yet, never Missed', async () => {
    const res = await service.gifsyReport(gifsy, {});
    expect(res.month).toBe('2026-11');
    expect(res.windows).toEqual([{ key: '2026-11-P1', closed: false }]);
    expect(res.summary).toMatchObject({ notCaptured: 1, missed: 0 });
  });

  it('imported old-app rows count in their own month like any capture', async () => {
    const res = await service.gifsyReport(gifsy, { month: '2026-10' });
    // The imported o1 row is the single Approved visit.
    expect(res.summary.approved).toBe(1);
    const list = await service.gifsyOutlets(gifsy, { month: '2026-10', status: 'APPROVED' });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ outletCode: 'A1', capturedBy: IMPORTED_LABEL, imported: true, reviewedBy: 'Gifsy Admin' });
  });

  it('frequency 2: a mid-month month has one closed + one open window; units are outlet-windows', async () => {
    wireFixture({ config: { frequencyPerMonth: 2 } });
    const res = await service.gifsyReport(gifsy, { month: '2026-11' });
    expect(res.windows).toEqual([
      { key: '2026-11-P1', closed: true },
      { key: '2026-11-P2', closed: false },
    ]);
    // 5 outlets × 2 windows. P1 (closed) has the 4 captures; P2 has none → 5 not captured; P1 o5 → missed.
    expect(res.summary).toMatchObject({
      inScope: 10, approved: 1, waiting: 1, needsRetake: 0, rejected: 0, closedNotApproved: 2, missed: 1, notCaptured: 5,
    });
    const one = await service.gifsyReport(gifsy, { month: '2026-11', windowKey: '2026-11-P2' });
    expect(one.windowKey).toBe('2026-11-P2');
    expect(one.summary).toMatchObject({ inScope: 5, notCaptured: 5, missed: 0 });
  });

  it('a window that is not in the month → 400; a windowKey alone implies its month', async () => {
    await expect(service.gifsyReport(gifsy, { month: '2026-10', windowKey: '2026-11-P1' })).rejects.toThrow(BadRequestException);
    const res = await service.gifsyReport(gifsy, { windowKey: '2026-10-P1' });
    expect(res.month).toBe('2026-10');
  });

  it('uses THE per-window in-scope rule for outlets AND captures: closed window = existed + KYC-approved then; open = today', async () => {
    await service.gifsyReport(gifsy, { month: '2026-10' }); // October is CLOSED (clock 20 Nov)
    const closedWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
    expect(closedWhere).toEqual(
      visibilityUniverseWhere('t1', baseConfig, {
        activeDuring: { start: new Date('2026-09-30T18:30:00Z'), end: new Date('2026-10-31T18:30:00Z') },
      }),
    );
    expect(mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where.outlet).toEqual(closedWhere);
    mockPrisma.outlet.findMany.mockClear();
    mockPrisma.visibilityCapture.findMany.mockClear();
    await service.gifsyReport(gifsy, { month: '2026-11' }); // November is OPEN → today's rule
    const openWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
    expect(openWhere).toEqual({
      clientId: 't1', deletedAt: null, deactivatedAt: null, isActive: true,
      OR: [{ kycIntent: null }, { kycIntent: { notIn: ['NOT_INTERESTED', 'PARKED'] } }],
      outletType: { code: { in: ['SSS'] } },
    });
    expect(mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where.outlet).toEqual(openWhere);
  });

  it('an outlet in scope for one window but not another only gets a slot where it is in scope', async () => {
    wireFixture({ config: { frequencyPerMonth: 2 } });
    // P1 (closed) universe holds o1..o4 only (o5 KYC-approved after P1); P2 (open) holds all five.
    mockPrisma.outlet.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(where.createdAt ? OUTLETS.filter((o) => o.id !== 'o5') : OUTLETS),
    );
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
    const res = await service.gifsyReport(gifsy, { month: '2026-11' }, ); // clock 20 Nov: P1 (1-15) closed, P2 open
    expect(res.summary).toMatchObject({ inScope: 9, missed: 4, notCaptured: 5 });
    expect(res.pastWindowScopeNote).toMatch(/KYC was approved before the window ended/);
  });

  it('APPLIES-TO: the program narrowing lands on outlets and captures together', async () => {
    wireFixture({ config: { programs: ['RLP'] } });
    const res = await service.gifsyReport(gifsy, { month: '2026-10' });
    const outletWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
    expect(outletWhere.AND[0].AND[1].OR[0].isActive).toBe(true); // closed window: active-then branch
    expect(mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where.outlet).toEqual(outletWhere);
    expect(res.programs).toEqual(['RLP']);
  });

  it('surfaces captures it does NOT count (out of scope / other window) instead of dropping them silently', async () => {
    const res = await service.gifsyReport(gifsy, { month: '2026-10' });
    expect(res.notCounted).toEqual({ outOfScope: 2, otherWindow: 1 });
  });

  it('breakdowns: programme / sub-programme, rep (assigned), first ACTIVE manager (vacant level skipped)', async () => {
    const res = await service.gifsyReport(gifsy, { month: '2026-10' });
    const prog = res.breakdowns.programme.map((r) => [r.label, r.inScope, r.approved]);
    expect(prog).toEqual([
      ['SAMT / No sub-programme', 1, 0],
      ['Unnati / Elite', 2, 1],
      ['Unnati / Privilege', 1, 0],
      ['No programme / No sub-programme', 1, 0],
    ]);
    const rep = res.breakdowns.rep.map((r) => [r.label, r.inScope]);
    expect(rep).toEqual([['Ravi (E1)', 2], ['Sita (E2)', 1], ['No rep assigned', 2]]);
    const mgr = res.breakdowns.manager.map((r) => [r.key, r.label, r.inScope]);
    // r1's direct manager m1 is inactive → Meera (m2); r2 → Meera too.
    expect(mgr).toEqual([['m2', 'Meera', 3], ['NONE', 'No active manager', 2]]);
    // Rows add up to the tiles.
    const sum = res.breakdowns.rep.reduce((n, r) => n + r.inScope, 0);
    expect(sum).toBe(res.summary.inScope);
  });

  it('outlet list: tile filter + breakdown filter + paging, with rep / captured / reviewed columns', async () => {
    const all = await service.gifsyOutlets(gifsy, { month: '2026-10', pageSize: 2, page: 2 });
    expect(all.pagination).toEqual({ page: 2, pageSize: 2, total: 5, pages: 3 });
    expect(all.rows.map((r) => r.outletCode)).toEqual(['A3', 'A4']);

    const retake = await service.gifsyOutlets(gifsy, { month: '2026-11', status: 'NEEDS_RETAKE' });
    expect(retake.rows).toEqual([
      expect.objectContaining({
        outletCode: 'A3', status: 'NEEDS_RETAKE', rep: 'Sita (E2)', manager: 'Meera',
        capturedBy: 'Sita (E2)', reviewedBy: 'Reviewer One', imported: false,
      }),
    ]);

    const missed = await service.gifsyOutlets(gifsy, { month: '2026-10', status: 'MISSED' });
    expect(missed.rows.map((r) => r.outletCode)).toEqual(['A5']);
    expect(missed.rows[0]).toMatchObject({ capturedBy: null, capturedOn: null, reviewedBy: null });

    const ravi = await service.gifsyOutlets(gifsy, { month: '2026-10', group: 'rep', groupKey: 'r1' });
    expect(ravi.rows.map((r) => r.outletCode)).toEqual(['A1', 'A2']);
    expect(ravi.groupLabel).toBe('Ravi (E1)');
  });

  it('imported month (before portal go-live): only the old app visits; coverage + Missed not tracked, also for windows 2+', async () => {
    wireFixture({ config: { frequencyPerMonth: 2 }, goLive: '2026-11' });
    mockPrisma.visibilityCapture.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(capturesFor('2026-10').filter((c) => c.id === 'c1' && where.windowKey.in.includes(c.windowKey))),
    );
    const res = await service.gifsyReport(gifsy, { month: '2026-10' });
    expect(res.importedMonth).toBe(true);
    expect(res.importedMonthNote).toMatch(/Not tracked for imported months/);
    expect(res.summary).toMatchObject({ inScope: 1, approved: 1, missed: 0, notCaptured: 0, coveragePct: null });
    expect(res.breakdowns.rep.every((r) => r.coveragePct === null && r.missed === 0)).toBe(true);
    const p2 = await service.gifsyReport(gifsy, { month: '2026-10', windowKey: '2026-10-P2' });
    expect(p2.summary).toMatchObject({ inScope: 0, missed: 0, coveragePct: null });
    const missed = await service.gifsyOutlets(gifsy, { month: '2026-10', status: 'MISSED' });
    expect(missed.pagination.total).toBe(0);
    // The current month is a portal month as usual.
    expect((await service.gifsyReport(gifsy, { month: '2026-11' })).importedMonth).toBe(false);
  });

  it('no portal capture at all: a month holding only imported captures is an imported month', async () => {
    wireFixture({ goLive: null, importedWindows: ['2026-10-P1'] });
    const res = await service.gifsyReport(gifsy, { month: '2026-10' });
    expect(res.importedMonth).toBe(true);
    expect(res.portalGoLive).toBeNull();
    expect(res.summary.missed).toBe(0);
    // A month with no captures at all is not imported (nothing to show as old-app history).
    expect((await service.gifsyReport(gifsy, { month: '2026-11' })).importedMonth).toBe(false);
  });

  it('a CLOSED window partly on the old app (began before go-live): no capture = "No approved record — part of this window was on the old app", never Missed (same rule as the Excel)', async () => {
    wireFixture({ goLive: new Date('2026-10-10T06:00:00Z') });
    const res = await service.gifsyReport(gifsy, { month: '2026-10' });
    expect(res.importedMonth).toBe(false);
    expect(res.portalGoLive).toBe('2026-10-10T06:00:00.000Z');
    expect(res.summary).toMatchObject({ missed: 0, partOldApp: 1 });
    const part = await service.gifsyOutlets(gifsy, { month: '2026-10', status: 'PART_OLD_APP' });
    expect(part.rows.map((r) => r.outletCode)).toEqual(['A5']);
    // A window that only HOLDS imported visits (began after go-live) is part old-app too.
    wireFixture({ goLive: new Date('2026-09-10T06:00:00Z'), importedWindows: ['2026-10-P1'] });
    expect((await service.gifsyReport(gifsy, { month: '2026-10' })).summary).toMatchObject({ missed: 0, partOldApp: 1 });
    // Fully after go-live and no imported visit → the normal Missed.
    wireFixture({ goLive: new Date('2026-09-10T06:00:00Z') });
    expect((await service.gifsyReport(gifsy, { month: '2026-10' })).summary).toMatchObject({ missed: 1, partOldApp: 0 });
  });

  it('"Imported" = photo stored under vendor-import/, not "no submitting rep" (a removed rep stays a portal capture)', async () => {
    mockPrisma.visibilityCapture.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        capturesFor('2026-10')
          .map((c) => (c.id === 'c4' ? { ...c, submittedBySalesUserId: null, submittedBy: null } : c))
          .filter((c) => where.windowKey.in.includes(c.windowKey)),
      ),
    );
    const list = await service.gifsyOutlets(gifsy, { month: '2026-10' });
    const by = Object.fromEntries(list.rows.map((r) => [r.outletCode, r]));
    expect(by.A1).toMatchObject({ imported: true, capturedBy: IMPORTED_LABEL });
    expect(by.A4).toMatchObject({ imported: false, capturedBy: 'Rep (no longer on file)' });
  });

  it('a resubmitted capture back in Waiting for review never shows the previous review as "reviewed"', async () => {
    mockPrisma.visibilityCapture.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        capturesFor('2026-10')
          .map((c) => (c.id === 'c2' ? { ...c, reviewedAt: new Date('2026-10-06T05:00:00Z'), approvedByUserId: 'rev1' } : c))
          .filter((c) => where.windowKey.in.includes(c.windowKey)),
      ),
    );
    const list = await service.gifsyOutlets(gifsy, { month: '2026-10', status: 'WAITING' });
    expect(list.rows[0]).toMatchObject({ outletCode: 'A2', reviewedBy: null, reviewedOn: null });
  });

  it('waiting after a resubmit: photo reviews dated BEFORE the last (re)submission are ignored; later ones show', () => {
    const receivedAt = new Date('2026-10-20T05:00:00Z');
    const carried = { status: 'APPROVED', reviewedAt: '2026-10-15T05:00:00.000Z', reviewedByUserId: 'old' };
    expect(reviewerOfCapture({ status: 'SUBMITTED', photoReviews: { w1: carried }, approvedByUserId: 'old', reviewedAt: new Date('2026-10-15T05:00:00Z'), receivedAt }))
      .toEqual({ userId: null, at: null });
    const fresh = { status: 'APPROVED', reviewedAt: '2026-10-21T05:00:00.000Z', reviewedByUserId: 'new' };
    expect(reviewerOfCapture({ status: 'SUBMITTED', photoReviews: { w1: carried, w2: fresh }, approvedByUserId: 'old', reviewedAt: null, receivedAt }))
      .toEqual({ userId: 'new', at: new Date('2026-10-21T05:00:00.000Z') });
    // A decided capture keeps its latest decision (no resubmission filter).
    expect(reviewerOfCapture({ status: 'APPROVED', photoReviews: { w1: carried }, approvedByUserId: 'old', reviewedAt: new Date('2026-10-15T05:00:00Z'), receivedAt }))
      .toEqual({ userId: 'old', at: new Date('2026-10-15T05:00:00Z') });
  });

  it('outlet list: group without groupKey → 400', async () => {
    await expect(service.gifsyOutlets(gifsy, { month: '2026-10', group: 'rep' })).rejects.toThrow(BadRequestException);
  });

  it('empty outlet scope → zeros, no outlet/capture query', async () => {
    wireFixture({ config: { outletScope: [] } });
    const res = await service.gifsyReport(gifsy, { month: '2026-10' });
    expect(res.summary).toMatchObject({ inScope: 0, coveragePct: 0 });
    expect(mockPrisma.outlet.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.visibilityCapture.findMany).not.toHaveBeenCalled();
  });

  // ── Gates ──────────────────────────────────────────────────────────────────
  it('gifsy report / outlets 403 a non-GIFSY caller; the tenant variants work for CLIENT_ADMIN', async () => {
    await expect(service.gifsyReport(clientAdmin, {})).rejects.toThrow(ForbiddenException);
    await expect(service.gifsyOutlets(clientAdmin, {})).rejects.toThrow(ForbiddenException);
    const res = await service.tenantReport(clientAdmin, { month: '2026-10' });
    expect(res.summary.approved).toBe(1);
    const list = await service.tenantOutlets(clientAdmin, { month: '2026-10' });
    expect(list.pagination.total).toBe(5);
  });

  it('403s when visibilityEnabled is OFF', async () => {
    mockTenant.resolveVisibilityEnabled.mockResolvedValue(false);
    await expect(service.tenantReport(clientAdmin, {})).rejects.toThrow(ForbiddenException);
    await expect(service.tenantOutlets(clientAdmin, {})).rejects.toThrow(ForbiddenException);
  });

  describe('assertExportScope (report export 400s before any file)', () => {
    const now = new Date('2026-11-20T06:00:00Z');
    it('a window the monthly frequency does not have (P2) with no captures → 400', async () => {
      mockPrisma.visibilityCapture.count.mockResolvedValue(0);
      await expect(service.assertExportScope('t1', { windowKey: '2026-11-P2' }, now)).rejects.toBeInstanceOf(BadRequestException);
    });
    it('the same window is allowed when captures exist for it (an older frequency)', async () => {
      mockPrisma.visibilityCapture.count.mockResolvedValue(3);
      await expect(service.assertExportScope('t1', { windowKey: '2026-11-P2' }, now)).resolves.toBeUndefined();
    });
    it('a malformed window key gives a plain 400 (never PNaN)', async () => {
      mockPrisma.visibilityCapture.count.mockResolvedValue(0);
      await expect(service.assertExportScope('t1', { windowKey: '2026-11-X' }, now)).rejects.toThrow("That window isn't valid.");
    });
    it('a future month / future window → 400; this month and past months are fine', async () => {
      mockPrisma.visibilityCapture.count.mockResolvedValue(0);
      await expect(service.assertExportScope('t1', { month: '2026-12' }, now)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.assertExportScope('t1', { windowKey: '2027-01-P1' }, now)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.assertExportScope('t1', { month: '2026-11' }, now)).resolves.toBeUndefined();
      await expect(service.assertExportScope('t1', { windowKey: '2026-10-P1' }, now)).resolves.toBeUndefined();
    });
  });
});

describe('report pure helpers', () => {
  const slot = (over: Partial<ReportSlot>): ReportSlot => ({
    outletId: 'o', outletCode: 'C', outletName: 'N', programme: null, subProgramme: null, windowKey: '2026-10-P1',
    windowClosed: true, status: 'MISSED', captureId: null, repId: null, repName: null, repCode: null,
    managerId: null, managerName: null, capturedBy: null, capturedOn: null, reviewedBy: null, reviewedOn: null,
    imported: false, ...over,
  });

  it('tallySlots: coverage = approved ÷ in scope (1 dp)', () => {
    expect(tallySlots([slot({ status: 'APPROVED' }), slot({ status: 'MISSED' }), slot({ status: 'WAITING' })])).toMatchObject({
      inScope: 3, approved: 1, missed: 1, waiting: 1, coveragePct: 33.3,
    });
    expect(tallySlots([]).coveragePct).toBe(0);
    // Imported month: coverage is not tracked (null), never a fabricated 0 / 100.
    expect(tallySlots([slot({ status: 'APPROVED' })], false).coveragePct).toBeNull();
  });

  it('groupKeyOf: blank programme values fall into the "No programme" bucket (trimmed)', () => {
    expect(groupKeyOf(slot({ programme: '  ', subProgramme: null }), 'programme').label).toBe('No programme / No sub-programme');
  });

  it('breakdown sorts by label with the "none" bucket last', () => {
    const rows = breakdown(
      [slot({ repId: null }), slot({ repId: 'b', repName: 'Bee' }), slot({ repId: 'a', repName: 'Ann' })],
      'rep',
    );
    expect(rows.map((r) => r.label)).toEqual(['Ann', 'Bee', 'No rep assigned']);
  });

});
