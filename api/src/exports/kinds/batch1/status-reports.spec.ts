/**
 * `visibility-status` and `kyc-status` export kinds — PARITY with the old xlsx branches of ReportsService
 * (buildXlsx over the same row objects the JSON path returns), paging, tenant scope, heavy rules, empty files.
 */
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { buildXlsx } from '../../../common/xlsx';
import { TenantService } from '../../../tenant/tenant.service';
import { KYC_STATUS_KIND, kycStatusRows, type KycStatusOutlet } from './kyc-status';
import { VISIBILITY_STATUS_KIND, visibilityStatusRow, type VisibilityStatusCapture } from './visibility-status';
import { expectSameWorkbook, fakeModuleRef, readBack, runKindToBuffer, seeded } from './parity-testkit-spec';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const gifsy: JwtPayload = { sub: 'g', role: 'GIFSY_ADMIN', clientId: 'bajaj', phone: '', name: '' };
const mis: JwtPayload = { sub: 'm', role: 'MIS_USER', clientId: 'bajaj', phone: '', name: '' };

// ─── visibility-status ─────────────────────────────────────────────────────────────────────────────────────

type Cap = VisibilityStatusCapture & { clientId: string };

function caps(n: number): Cap[] {
  const rnd = seeded(5);
  const out: Cap[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `c${String(i).padStart(6, '0')}`,
      clientId: i % 17 === 0 ? 'other' : 'bajaj',
      outletCode: `OC${i % 300}`,
      outletName: i === 4 ? '+evil' : `Snap ${i}`,
      windowKey: '2026-09-P1',
      status: 'APPROVED',
      captureLat: rnd() < 0.5 ? new Prisma.Decimal('19.07600000') : null,
      captureLng: rnd() < 0.5 ? new Prisma.Decimal('72.87770000') : null,
      geoFenceOk: [true, false, null][i % 3] as boolean | null,
      // Many share a createdAt so the (createdAt, id) keyset tie-break is exercised.
      createdAt: new Date(Date.parse('2026-09-01T00:00:00Z') + Math.floor(i / 3) * 3_600_000),
      outlet: i !== 4 && rnd() < 0.8 ? { name: `Outlet ${i % 300}`, city: rnd() < 0.5 ? 'Pune' : null } : null,
      submittedBy: rnd() < 0.8 ? { user: { name: `Rep ${i % 20}` } } : null,
    } as Cap);
  }
  return out;
}

function capPrisma(rows: Cap[]) {
  const calls: Array<Record<string, any>> = [];
  return {
    calls,
    visibilityCapture: {
      findMany: async (a: Record<string, any>) => {
        calls.push(a);
        const base = a.where.AND ? a.where.AND[0] : a.where;
        const ks = a.where.AND ? a.where.AND[1].OR : null;
        let r = rows.filter((c) => c.clientId === base.clientId);
        if (base.createdAt?.gte) r = r.filter((c) => c.createdAt >= base.createdAt.gte);
        if (base.createdAt?.lte) r = r.filter((c) => c.createdAt <= base.createdAt.lte);
        if (ks) r = r.filter((c) => c.createdAt < ks[0].createdAt.lt || (+c.createdAt === +ks[1].createdAt && c.id < ks[1].id.lt));
        r = [...r].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || cmp(y.id, x.id));
        return a.take ? r.slice(0, a.take) : r;
      },
    },
  };
}

/** The OLD xlsx branch: buildXlsx over the mapped rows (an empty list → a header-less blank sheet). */
async function oldVisibilityStatus(rows: Cap[], clientId: string, from?: Date, to?: Date): Promise<Buffer> {
  const sel = rows
    .filter((c) => c.clientId === clientId && (!from || c.createdAt >= from) && (!to || c.createdAt <= to))
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || cmp(y.id, x.id));
  return buildXlsx([{ name: 'Visibility Status', rows: sel.map((s, i) => visibilityStatusRow(s, i + 1)) }]);
}

const tenantRef = (enabled: boolean) => fakeModuleRef([[TenantService, { resolveVisibilityEnabled: async () => enabled }]]);

// Thousands of rows through two full xlsx builds per test: allow for a loaded CI box.
jest.setTimeout(120_000);

describe('visibility-status export kind', () => {
  it('PARITY (all dates, ~4,700 rows of this tenant = 3 pages, createdAt ties)', async () => {
    const rows = caps(5000);
    const prisma = capPrisma(rows);
    const res = await runKindToBuffer(VISIBILITY_STATUS_KIND, { format: 'xlsx' }, { prisma, moduleRef: tenantRef(true), user: mis });
    const got = expectSameWorkbook(res.buffer, await oldVisibilityStatus(rows, 'bajaj'));
    const mine = rows.filter((c) => c.clientId === 'bajaj').length;
    expect(res.rowCount).toBe(mine);
    expect(got.rows['Visibility Status'][mine][0]).toBe(mine); // S.No runs across pages
    expect(prisma.calls).toHaveLength(3);
    expect(prisma.calls[0].select.formValues).toBeUndefined(); // explicit select — no form JSON
    expect(res.heavy).toBe(true);
    expect(res.fileName).toBe('visibility-status.xlsx');
  });

  it('PARITY (a bounded range ≤ 1 month: light, IST-day bounds)', async () => {
    const rows = caps(3000);
    const params = { dateFrom: '2026-09-10', dateTo: '2026-09-30' };
    const res = await runKindToBuffer(VISIBILITY_STATUS_KIND, params, { prisma: capPrisma(rows), moduleRef: tenantRef(true), user: mis });
    // IST day bounds, as istDayRangeFilter: 00:00 IST of the 10th → 23:59:59.999 IST of the 30th.
    const from = new Date('2026-09-09T18:30:00.000Z');
    const to = new Date('2026-09-30T18:29:59.999Z');
    expectSameWorkbook(res.buffer, await oldVisibilityStatus(rows, 'bajaj', from, to));
    expect(res.heavy).toBe(false);
  });

  it('PARITY (no rows): a blank sheet with no header row, exactly like the old file', async () => {
    const res = await runKindToBuffer(VISIBILITY_STATUS_KIND, {}, { prisma: capPrisma([]), moduleRef: tenantRef(true), user: mis });
    const got = expectSameWorkbook(res.buffer, await oldVisibilityStatus([], 'bajaj'));
    expect(got.rows['Visibility Status']).toEqual([]);
  });

  it('cellSafe + master switch: 403 for a tenant user when OFF; un-assumed Gifsy exempt', async () => {
    const rows = caps(10);
    const ok = await runKindToBuffer(VISIBILITY_STATUS_KIND, {}, { prisma: capPrisma(rows), moduleRef: tenantRef(false), user: gifsy });
    expect(JSON.stringify(readBack(ok.buffer).rows)).toContain("'+evil");
    await expect(
      runKindToBuffer(VISIBILITY_STATUS_KIND, {}, { prisma: capPrisma(rows), moduleRef: tenantRef(false), user: mis }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('heavy rule: light only for both dates within 31 days', () => {
    const p = (q: Record<string, unknown>) => VISIBILITY_STATUS_KIND.isHeavy(VISIBILITY_STATUS_KIND.parseParams(q, mis));
    expect(p({})).toBe(true);
    expect(p({ dateFrom: '2026-09-01' })).toBe(true);
    expect(p({ dateFrom: '2026-09-01', dateTo: '2026-09-30' })).toBe(false);
    expect(p({ dateFrom: '2026-09-01', dateTo: '2026-10-01' })).toBe(false); // 31 days inclusive
    expect(p({ dateFrom: '2026-09-01', dateTo: '2026-10-02' })).toBe(true);
    expect(p({ dateFrom: 'garbage', dateTo: '2026-10-02' })).toBe(true);
    expect(VISIBILITY_STATUS_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'MIS_USER'], permission: 'reports:read' });
  });
});

// ─── kyc-status ────────────────────────────────────────────────────────────────────────────────────────────

type Out = KycStatusOutlet & { clientId: string; deletedAt: Date | null };

function outlets(n: number): Out[] {
  const rnd = seeded(9);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const out: Out[] = [];
  for (let i = 0; i < n; i++) {
    const hasSub = rnd() < 0.8;
    out.push({
      id: `o${String(i).padStart(6, '0')}`,
      clientId: i % 23 === 0 ? 'other' : 'bajaj',
      deletedAt: i % 41 === 0 ? new Date() : null,
      zone: pick(['N', null]),
      outletCode: i % 50 === 0 ? 'SAMECODE' : `K${String((i * 7919) % 10007).padStart(5, '0')}`,
      name: i === 2 ? '=bad()' : `Outlet ${i}`,
      programName: pick(['RLP', null]),
      deactivatedAt: rnd() < 0.05 ? new Date('2026-06-01T00:00:00Z') : null,
      kycIntent: pick([null, null, 'PARKED', 'NOT_INTERESTED']),
      partner: rnd() < 0.9
        ? {
            ownerName: 'Own', phone: '9', businessName: 'Biz', panNumber: 'PAN',
            kycSubmissions: hasSub
              ? [{
                  status: pick(['APPROVED', 'REJECTED', 'PENDING_GIFSY', 'SUBMITTED', 'DRAFT']),
                  submittedAt: rnd() < 0.8 ? new Date('2026-05-01T10:00:00Z') : null,
                  createdAt: new Date('2026-04-30T10:00:00Z'),
                  id: `s${i}`, rejectionReason: pick([null, 'GST']), reviewerNotes: pick([null, 'note']),
                  reviewedAt: rnd() < 0.5 ? new Date('2026-05-03T10:00:00Z') : null,
                  statusHistory: rnd() < 0.7
                    ? [{ createdAt: new Date('2026-05-02T10:00:00Z'), changedByUserId: pick(['ua', 'ub', 'uc', null]), fromStatus: pick(['PENDING_GIFSY', 'SUBMITTED', null]) }]
                    : [],
                }]
              : [],
          }
        : null,
    } as unknown as Out);
  }
  return out;
}

function outletPrisma(
  rows: Out[],
  opts: { features?: Record<string, unknown> | null; history?: Array<Record<string, unknown>> } = {},
) {
  const calls: Array<Record<string, any>> = [];
  const historyCalls: Array<Record<string, any>> = [];
  const users = [
    { id: 'ua', name: 'Gifsy A', role: 'GIFSY_ADMIN' },
    { id: 'ub', name: 'State Head', role: 'SALES_STATE_HEAD' },
    { id: 'uc', name: 'No Role', role: null },
  ];
  return {
    calls,
    historyCalls,
    // Tenant features (gifsyRejectFastTrack drives the Bajaj-only "Routing" column). null = no client row.
    client: { findUnique: async () => (opts.features === null || opts.features === undefined ? null : { features: opts.features }) },
    kycStatusHistory: {
      findMany: async (a: Record<string, any>) => {
        historyCalls.push(a);
        return (opts.history ?? []).filter((h) => a.where.kycSubmissionId.in.includes(h.kycSubmissionId));
      },
    },
    outlet: {
      findMany: async (a: Record<string, any>) => {
        calls.push(a);
        let r = rows.filter((o) => o.clientId === a.where.clientId && o.deletedAt === null);
        if (a.where.OR) {
          const gt = a.where.OR[0].outletCode.gt;
          r = r.filter((o) => o.outletCode > gt || (o.outletCode === a.where.OR[1].outletCode && o.id > a.where.OR[1].id.gt));
        }
        r = [...r].sort((x, y) => cmp(x.outletCode, y.outletCode) || cmp(x.id, y.id));
        return a.take ? r.slice(0, a.take) : r;
      },
    },
    user: { findMany: async (a: Record<string, any>) => users.filter((u) => a.where.id.in.includes(u.id)) },
  };
}

/** The OLD xlsx branch: all outlets at once → the same row builder → buildXlsx (empty → one blank row). */
async function oldKycStatus(rows: Out[], clientId: string): Promise<Buffer> {
  const prisma = outletPrisma(rows);
  const all = await prisma.outlet.findMany({ where: { clientId, deletedAt: null } });
  const data = await kycStatusRows(prisma as never, clientId, all);
  const blank = { 'S.No': '', 'Outlet ID': '', 'Outlet Name': '', Zone: '', 'Program Name': '', 'Business Name': '',
    'Owner/User Name': '', Mobile: '', PAN: '', Status: '', 'Last Submitted On': '', 'Rejected Stage': '', 'Rejected By': '',
    'Rejection Reason': '', 'Reviewer Notes': '', 'Rejected On': '' };
  return buildXlsx([{ name: 'KYC Status', rows: data.length ? data : [blank] }]);
}

describe('kyc-status export kind', () => {
  it('PARITY (≈4,400 live outlets of this tenant = 3 pages)', async () => {
    const rows = outlets(4800);
    const prisma = outletPrisma(rows);
    const res = await runKindToBuffer(KYC_STATUS_KIND, { format: 'xlsx', dateFrom: '2026-01-01' }, { prisma, moduleRef: fakeModuleRef([]), user: mis });
    const got = expectSameWorkbook(res.buffer, await oldKycStatus(rows, 'bajaj'));
    expect(prisma.calls).toHaveLength(3);
    expect(prisma.calls.every((c) => c.where.clientId === 'bajaj')).toBe(true);
    const sheet = got.rows['KYC Status'];
    expect(sheet[sheet.length - 1][0]).toBe(sheet.length - 1); // S.No continues across pages
    expect(JSON.stringify(sheet)).toContain("'=bad()");
    expect(res.heavy).toBe(true);
    expect(res.fileName).toBe('kyc-status.xlsx');
  });

  it('PARITY (empty tenant): headers + one blank row', async () => {
    const res = await runKindToBuffer(KYC_STATUS_KIND, {}, { prisma: outletPrisma([]), moduleRef: fakeModuleRef([]), user: mis });
    const got = expectSameWorkbook(res.buffer, await oldKycStatus([], 'bajaj'));
    expect(got.rows['KYC Status']).toHaveLength(2);
  });

  it('access mirrors the endpoint', () => {
    expect(KYC_STATUS_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'MIS_USER', 'CLIENT_ADMIN'], permission: 'reports:read' });
  });

  // ── GIFSY-reject fast-track "Routing" column — ONLY for a gifsyRejectFastTrack tenant ──
  const ftOutlet = (id: string, subId: string): Out =>
    ({
      id, clientId: 'bajaj', deletedAt: null, zone: null, outletCode: `C-${id}`, name: `Outlet ${id}`, programName: null,
      deactivatedAt: null, kycIntent: null,
      partner: {
        ownerName: 'Own', phone: '9', businessName: 'Biz', panNumber: 'PAN',
        kycSubmissions: [{
          status: 'PENDING_GIFSY', submittedAt: new Date(), createdAt: new Date(), id: subId,
          rejectionReason: null, reviewerNotes: null, reviewedAt: null, statusHistory: [],
        }],
      },
    }) as unknown as Out;
  const ftHistory = [{
    kycSubmissionId: 's-ft', fromStatus: 'DRAFT', toStatus: 'PENDING_GIFSY', createdAt: new Date(),
    metadata: { fastTrack: 'GIFSY_REJECT_RESUBMISSION', previousSubmissionId: 's-old', previousRejectedAt: new Date().toISOString() },
  }];

  it('flag ON (Bajaj): appends a "Routing" column — label for a fast-tracked latest submission, blank otherwise', async () => {
    const prisma = outletPrisma([ftOutlet('a', 's-ft'), ftOutlet('b', 's-normal')], { features: { gifsyRejectFastTrack: true }, history: ftHistory });
    const res = await runKindToBuffer(KYC_STATUS_KIND, {}, { prisma, moduleRef: fakeModuleRef([]), user: mis });
    const sheet = readBack(res.buffer).rows['KYC Status'];
    expect(sheet[0][sheet[0].length - 1]).toBe('Routing');
    const idx = sheet[0].indexOf('Routing');
    expect(sheet[1][idx]).toBe('Direct to GIFSY (resubmitted after GIFSY rejection)');
    expect(sheet[2][idx] ?? '').toBe('');
    expect(prisma.historyCalls).toHaveLength(1); // ONE batched query per page
  });

  it('flag OFF (Deoleo): header + rows byte-identical — no Routing column, no history query', async () => {
    const prisma = outletPrisma([ftOutlet('a', 's-ft')], { features: { gifsyRejectFastTrack: false }, history: ftHistory });
    const res = await runKindToBuffer(KYC_STATUS_KIND, {}, { prisma, moduleRef: fakeModuleRef([]), user: mis });
    expectSameWorkbook(res.buffer, await oldKycStatus([ftOutlet('a', 's-ft')], 'bajaj'));
    expect(readBack(res.buffer).rows['KYC Status'][0]).not.toContain('Routing');
    expect(prisma.historyCalls).toHaveLength(0);
  });

  it('JSON row builder: Routing key only when asked (routing:true)', async () => {
    const prisma = outletPrisma([], { history: ftHistory });
    const off = await kycStatusRows(prisma as never, 'bajaj', [ftOutlet('a', 's-ft')]);
    expect('Routing' in off[0]).toBe(false);
    const on = await kycStatusRows(prisma as never, 'bajaj', [ftOutlet('a', 's-ft')], 0, { routing: true });
    expect(on[0].Routing).toBe('Direct to GIFSY (resubmitted after GIFSY rejection)');
  });
});
