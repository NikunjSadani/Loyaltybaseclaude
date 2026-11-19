import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  buildLocationReport,
  istBounds,
  LOCATION_TIMEOUT_MESSAGE,
  locationAggregateSql,
  pageOfLocationReport,
  resolveLocationParams,
  type LocationAggRow,
  type LocationParams,
} from './location-compliance-report';
import { ReportsService } from '../reports.service';
import {
  LOCATION_ABOUT_SHEET,
  LOCATION_COMPLIANCE_KIND,
  LOCATION_REPORT_HEADERS,
  LOCATION_REPORT_NONE_MESSAGE,
} from '../../exports/kinds/batch2/location-compliance.kind';
import { startPgliteTestDb, type PgliteTestDb } from '../../common/testing/pglite-testkit-spec';

const NOW = new Date('2026-11-20T06:30:00.000Z'); // 12:00 IST

const params = (over: Partial<LocationParams> = {}): LocationParams => ({
  from: '2026-11-01',
  to: '2026-11-30',
  role: null,
  region: null,
  sort: 'issues',
  page: 1,
  pageSize: 50,
  ...over,
});

const agg = (userId: string | null, o: Partial<LocationAggRow> = {}): LocationAggRow => ({
  userId,
  isTotal: userId === null ? 1 : 0,
  kycs: 0,
  visibilityCaptures: 0,
  noGps: 0,
  poorAccuracy: 0,
  unverifiable: 0,
  blockedOutside: 0,
  medianAccuracyM: null,
  medianLockMs: null,
  ...o,
});

function fixtures() {
  return {
    features: { bajaj: { requireLocation: true, outletMasterGeo: true }, deoleo: {} } as Record<string, Record<string, unknown>>,
    users: [
      { id: 'isr1', clientId: 'bajaj', name: 'Asha ISR', phone: '919876500001', role: 'SALES_ISR', salesUser: { region: null, zone: null } },
      { id: 'so1', clientId: 'bajaj', name: 'Bala SO', phone: '919876500002', role: 'SALES_SO', salesUser: { region: 'West', zone: null } },
      { id: 'isr2', clientId: 'bajaj', name: 'Idle ISR', phone: '919876500003', role: 'SALES_ISR', salesUser: { region: null, zone: null } },
      { id: 'dso', clientId: 'deoleo', name: 'Deoleo SO', phone: '919800000001', role: 'SALES_SO', salesUser: null },
    ],
    assignments: [
      { salesUser: { userId: 'isr1', clientId: 'bajaj' }, outlet: { state: 'Maharashtra', deletedAt: null, clientId: 'bajaj' } },
      { salesUser: { userId: 'so1', clientId: 'bajaj' }, outlet: { state: 'Gujarat', deletedAt: null, clientId: 'bajaj' } },
    ],
    // What Postgres would return for the bajaj population (the SQL itself is proven against PGlite below).
    agg: [
      agg('isr1', { kycs: 4, visibilityCaptures: 6, noGps: 1, poorAccuracy: 2, unverifiable: 1, blockedOutside: 3, medianAccuracyM: 14.6, medianLockMs: 2100 }),
      agg('so1', { kycs: 1, visibilityCaptures: 0, medianAccuracyM: 8, medianLockMs: 900 }),
      agg(null, { kycs: 5, visibilityCaptures: 6, noGps: 1, poorAccuracy: 2, unverifiable: 1, blockedOutside: 3, medianAccuracyM: '12', medianLockMs: '1500' }),
    ],
  };
}

function fakePrisma(fx = fixtures()) {
  // eslint-disable-next-line prefer-const
  let ref: any;
  const prisma = {
    client: { findUnique: jest.fn(async ({ where }: any) => ({ features: fx.features[where.id] ?? {} })) },
    programSetting: { findUnique: jest.fn(async () => null) },
    user: { findMany: jest.fn(async ({ where }: any) => fx.users.filter((u) => u.clientId === where.clientId && where.role.in.includes(u.role))) },
    salesUserAssignment: {
      findMany: jest.fn(async ({ where }: any) => fx.assignments.filter((a) => a.salesUser.clientId === where.salesUser.clientId)),
    },
    $executeRawUnsafe: jest.fn(async () => 0),
    $transaction: jest.fn(async (fn: any) => fn(ref)),
    $queryRaw: jest.fn(async (sql: any) => (sql.values[0] === 'bajaj' ? fx.agg : [])),
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  ref = prisma;
  return prisma;
}

describe('resolveLocationParams', () => {
  it('defaults: last 30 IST days, issues sort, page 1 × 50', () => {
    expect(resolveLocationParams({}, NOW)).toEqual({
      from: '2026-10-22', to: '2026-11-20', role: null, region: null, sort: 'issues', page: 1, pageSize: 50,
    });
  });

  it('IST bounds: inclusive days → [00:00 IST, next-day 00:00 IST)', () => {
    const b = istBounds('2026-11-01', '2026-11-30');
    expect(b.start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(b.end.toISOString()).toBe('2026-11-30T18:30:00.000Z');
  });
});

describe('buildLocationReport', () => {
  it('TENANT ISOLATION: every read pinned to the caller tenant; another tenant never appears', async () => {
    const prisma = fakePrisma();
    const r = await buildLocationReport(prisma as any, 'bajaj', params(), NOW);
    expect(prisma.user.findMany.mock.calls[0][0].where.clientId).toBe('bajaj');
    expect(prisma.salesUserAssignment.findMany.mock.calls[0][0].where.salesUser).toEqual({ clientId: 'bajaj' });
    const sql = prisma.$queryRaw.mock.calls[0][0];
    expect(sql.values[0]).toBe('bajaj');
    const repIds = sql.values.find((v: unknown) => Array.isArray(v));
    expect(repIds.sort()).toEqual(['isr1', 'isr2', 'so1']); // only bajaj sales users
    expect(r.rows.map((x) => x.userId)).not.toContain('dso');
  });

  it('refuses a missing tenant (403) before any read', async () => {
    const prisma = fakePrisma();
    await expect(buildLocationReport(prisma as any, ' ', params(), NOW)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('rows = reps with activity only; numbers + rounded medians; totals from the SQL totals row', async () => {
    const r = await buildLocationReport(fakePrisma() as any, 'bajaj', params(), NOW);
    expect(r.rows.map((x) => x.userId)).toEqual(['isr1', 'so1']); // isr2 had nothing → not listed
    expect(r.rows[0]).toMatchObject({
      kycs: 4, visibilityCaptures: 6, noGps: 1, poorAccuracy: 2, unverifiable: 1, blockedOutside: 3,
      medianAccuracyM: 15, medianLockMs: 2100, regions: ['Maharashtra'],
    });
    expect(r.rows[1].regions).toEqual(['West']); // employee-record region wins over the assigned outlet state
    expect(r.totals).toEqual({
      reps: 2, kycs: 5, visibilityCaptures: 6, noGps: 1, poorAccuracy: 2, unverifiable: 1, blockedOutside: 3,
      medianAccuracyM: 12, medianLockMs: 1500,
    });
    expect(r.setting).toEqual({ requireLocation: true, fenceOn: true, outletMasterFence: true });
  });

  it('role / region filters shrink the rep ids sent to SQL (totals follow the filter)', async () => {
    const prisma = fakePrisma();
    await buildLocationReport(prisma as any, 'bajaj', params({ region: 'west' }), NOW);
    const ids = prisma.$queryRaw.mock.calls[0][0].values.find((v: unknown) => Array.isArray(v));
    expect(ids).toEqual(['so1']);
    prisma.$queryRaw.mockClear();
    await buildLocationReport(prisma as any, 'bajaj', params({ role: 'SALES_ISR' }), NOW);
    expect(prisma.$queryRaw.mock.calls[0][0].values.find((v: unknown) => Array.isArray(v)).sort()).toEqual(['isr1', 'isr2']);
  });

  it('no reps in the filter → no SQL at all, empty totals', async () => {
    const prisma = fakePrisma();
    const r = await buildLocationReport(prisma as any, 'bajaj', params({ region: 'Nowhere' }), NOW);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(r.rows).toEqual([]);
    expect(r.totals.reps).toBe(0);
    expect(r.totals.medianAccuracyM).toBeNull();
  });

  it('Deoleo (setting absent, no fence): reports setting OFF and fence OFF', async () => {
    const r = await buildLocationReport(fakePrisma() as any, 'deoleo', params(), NOW);
    expect(r.setting).toEqual({ requireLocation: false, fenceOn: false, outletMasterFence: false });
  });

  it('statement timeout → a clear 503 worded for this report', async () => {
    const prisma = fakePrisma();
    prisma.$transaction.mockRejectedValueOnce(new Error('canceling statement due to statement timeout (57014)'));
    await expect(buildLocationReport(prisma as any, 'bajaj', params(), NOW)).rejects.toThrow(
      new ServiceUnavailableException(LOCATION_TIMEOUT_MESSAGE),
    );
  });

  it('sorts by issues (default) / captures / name; pagination keeps totals', async () => {
    const prisma = fakePrisma();
    expect((await buildLocationReport(prisma as any, 'bajaj', params({ sort: 'name' }), NOW)).rows.map((r) => r.userId)).toEqual(['isr1', 'so1']);
    const r = await buildLocationReport(prisma as any, 'bajaj', params(), NOW);
    const pg = pageOfLocationReport(r, params({ page: 2, pageSize: 1 }));
    expect(pg).toMatchObject({ page: 2, pageCount: 2, totalRows: 2 });
    expect(pg.rows.map((x) => x.userId)).toEqual(['so1']);
    expect(pg.totals).toEqual(r.totals);
  });
});

// ─── The aggregate SQL against a REAL Postgres (PGlite) ─────────────────────────────────────────────────────
describe('locationAggregateSql — real Postgres', () => {
  let db: PgliteTestDb;
  const { start, end } = istBounds('2026-11-01', '2026-11-30');

  beforeAll(async () => {
    db = startPgliteTestDb();
    await db.exec(`
      CREATE TABLE "users" ("id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL);
      CREATE TABLE "sales_users" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "clientId" TEXT NOT NULL);
      CREATE TABLE "kyc_submissions" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "submittedAt" TIMESTAMP(3),
        "boardPhotoLat" DECIMAL(10,8), "boardPhotoLng" DECIMAL(11,8), "boardPhotoGeoAccuracy" DECIMAL(8,2),
        "geoFenceStatus" TEXT, "geoLockMs" INTEGER);
      CREATE TABLE "visibility_capture_submissions" ("id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL,
        "submittedBySalesUserId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL, "captureLat" DECIMAL(10,8),
        "captureLng" DECIMAL(11,8), "captureAccuracy" DECIMAL(8,2), "geoFenceOk" BOOLEAN);
      CREATE TABLE "audit_logs" ("id" TEXT PRIMARY KEY, "actorId" TEXT, "entityType" TEXT NOT NULL, "metadata" JSONB,
        "createdAt" TIMESTAMP(3) NOT NULL);

      INSERT INTO "users" VALUES ('r1','bajaj'), ('r2','bajaj'), ('x1','deoleo');
      INSERT INTO "sales_users" VALUES ('su1','r1','bajaj'), ('su2','r2','bajaj'), ('sx1','x1','deoleo');

      INSERT INTO "kyc_submissions" VALUES
        ('k1','r1','2026-11-05 06:00', 12.9, 77.5, 10,  'OK',           1000),
        ('k2','r1','2026-11-06 06:00', 12.9, 77.5, 80,  'UNVERIFIABLE', 3000),
        ('k3','r1','2026-11-07 06:00', NULL, NULL, NULL,'UNVERIFIABLE', NULL),
        ('k4','r1','2026-10-31 18:00', 12.9, 77.5, 5,   'OK',           100),   -- 23:30 IST 31 Oct → before range
        ('k5','r1','2026-11-30 18:29', 12.9, 77.5, 30,  'OK',           2000),  -- 23:59 IST 30 Nov → last minute, in
        ('k6','r1','2026-11-30 18:31', 12.9, 77.5, 30,  'OK',           2000),  -- 00:01 IST 1 Dec → after range
        ('k7','x1','2026-11-05 06:00', NULL, NULL, NULL, NULL, NULL);           -- other tenant

      INSERT INTO "visibility_capture_submissions" VALUES
        ('v1','bajaj','su1','2026-11-10 06:00', 12.9, 77.5, 20,   true),
        ('v2','bajaj','su1','2026-11-11 06:00', NULL, NULL, NULL, NULL),
        ('v3','bajaj','su2','2026-11-12 06:00', 12.9, 77.5, 60,   NULL),
        ('v4','deoleo','sx1','2026-11-12 06:00', NULL, NULL, NULL, NULL);

      INSERT INTO "audit_logs" VALUES
        ('a1','r1','LOCATION_FENCE_BLOCK','{"flow":"KYC","clientId":"bajaj"}','2026-11-08 06:00'),
        ('a2','r2','LOCATION_FENCE_BLOCK','{"flow":"VISIBILITY","clientId":"bajaj"}','2026-11-08 07:00'),
        ('a3','r2','USAGE_REPORT','{"clientId":"bajaj"}','2026-11-08 07:00'),
        ('a4','x1','LOCATION_FENCE_BLOCK','{"flow":"KYC","clientId":"deoleo"}','2026-11-08 07:00');
    `);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it('per-rep counts, medians and ONE totals row; range edges in IST; other tenants excluded', async () => {
    const sql = locationAggregateSql('bajaj', ['r1', 'r2', 'x1'], start, end, true);
    const rows = await db.query<any>(sql.text, sql.values as unknown[]);
    const by = new Map(rows.map((r) => [r.isTotal === 1 ? 'TOTAL' : r.userId, r]));
    expect([...by.keys()].sort()).toEqual(['TOTAL', 'r1', 'r2']);
    // r1: KYC k1,k2,k3,k5 (4) + visibility v1,v2 (2) + 1 block
    expect(by.get('r1')).toMatchObject({
      kycs: 4, visibilityCaptures: 2, noGps: 2, poorAccuracy: 1, unverifiable: 3, blockedOutside: 1,
    });
    // accuracies with a fix: 10, 80, 30, 20 → median 25 ; lock ms (KYC, non-null): 1000, 3000, 2000 → 2000
    expect(Number(by.get('r1').medianAccuracyM)).toBe(25);
    expect(Number(by.get('r1').medianLockMs)).toBe(2000);
    expect(by.get('r2')).toMatchObject({ kycs: 0, visibilityCaptures: 1, noGps: 0, poorAccuracy: 1, unverifiable: 1, blockedOutside: 1 });
    expect(by.get('r2').medianLockMs).toBeNull();
    expect(by.get('TOTAL')).toMatchObject({ kycs: 4, visibilityCaptures: 3, noGps: 2, poorAccuracy: 2, unverifiable: 4, blockedOutside: 2 });
    // all fixes: 10, 80, 30, 20, 60 → 30
    expect(Number(by.get('TOTAL').medianAccuracyM)).toBe(30);
  });

  it('fence OFF → a visibility capture with geoFenceOk NULL is NOT counted unverifiable', async () => {
    const sql = locationAggregateSql('bajaj', ['r2'], start, end, false);
    const rows = await db.query<any>(sql.text, sql.values as unknown[]);
    expect(rows.find((r) => r.isTotal === 0)).toMatchObject({ unverifiable: 0 });
  });
});

describe('ReportsService.locationCompliance + export kind', () => {
  it('JSON: one page + totals for the caller tenant', async () => {
    const svc = new ReportsService(fakePrisma() as any, {} as any);
    const res: any = await svc.locationCompliance({ sub: 'u', role: 'CLIENT_ADMIN', clientId: 'bajaj' } as any, { pageSize: 1 } as any);
    expect(res.kind).toBe('json');
    expect(res.data).toMatchObject({ page: 1, pageSize: 1, totalRows: 2, pageCount: 2 });
  });

  function writer() {
    const sheets: Array<{ name: string; headers: readonly string[]; rows: unknown[][] }> = [];
    return {
      sheets,
      addSheet: jest.fn(async (name: string, headers: string[]) => {
        const s = { name, headers, rows: [] as unknown[][] };
        sheets.push(s);
        return { addRow: async (r: unknown[]) => void s.rows.push(r) };
      }),
    };
  }
  const user = { sub: 'admin-1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'A' } as any;

  it('Excel: audit row BEFORE bytes; data sheet + TOTAL row; About sheet', async () => {
    const prisma = fakePrisma();
    const out = writer();
    const order: string[] = [];
    prisma.auditLog.create.mockImplementation(async () => void order.push('audit'));
    out.addSheet.mockImplementationOnce(async (name: string, headers: string[]) => {
      order.push('sheet');
      const s = { name, headers, rows: [] as unknown[][] };
      out.sheets.push(s);
      return { addRow: async (r: unknown[]) => void s.rows.push(r) };
    });
    const res = await LOCATION_COMPLIANCE_KIND.run({ prisma, user, now: NOW } as any, params(), out as any);
    expect(order).toEqual(['audit', 'sheet']);
    expect(res.rowCount).toBe(2);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'EXPORT', entityType: 'LOCATION_COMPLIANCE_REPORT', entityId: 'bajaj' });
    expect(out.sheets[0].headers).toEqual([...LOCATION_REPORT_HEADERS]);
    expect(out.sheets[0].rows).toHaveLength(3); // 2 reps + TOTAL
    expect(String(out.sheets[0].rows[2][0])).toMatch(/^TOTAL/);
    expect(out.sheets[0].rows[0][11]).toBe(2.1); // 2100 ms → 2.1 s
    expect(out.sheets[1].name).toBe(LOCATION_ABOUT_SHEET);
    expect(out.sheets[1].rows.map((r) => r[0])).toContain('Blocked outside fence');
  });

  it('Excel: 0 reps → 404, no audit row', async () => {
    const prisma = fakePrisma();
    await expect(
      LOCATION_COMPLIANCE_KIND.run({ prisma, user, now: NOW } as any, params({ region: 'Nowhere' }), writer() as any),
    ).rejects.toThrow(new NotFoundException(LOCATION_REPORT_NONE_MESSAGE));
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
