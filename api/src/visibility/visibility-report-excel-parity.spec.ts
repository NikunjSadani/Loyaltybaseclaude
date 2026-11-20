/**
 * PARITY: the report screen (VisibilityReportService) and the Visibility Excel (export kind `visibility-captures`) must
 * count the SAME visits for the same month / window — one in-scope rule per window (visibilityWindowUniverseWhere: a
 * closed window = outlets that existed, were active and KYC-approved then; an open window = today's), one go-live rule,
 * one set of status words. Both run against ONE in-memory fixture whose outlet queries are answered by the real rule
 * (outlet-where-testkit), so a drift in either surface shows up as unequal counts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as XLSX from 'xlsx';
import { VisibilityReportService } from './visibility-report.service';
import { clearVisibilityGoLiveCache } from './visibility-portal-go-live';
import { FakeOutletRow, matchOutlet } from './outlet-where-testkit-spec';
import { TenantService } from '../tenant/tenant.service';
import { TenantSettingsService } from '../tenant/tenant-settings.service';
import { VISIBILITY_CAPTURES_KIND } from '../exports/kinds/batch1/visibility-captures';
import { fakeModuleRef, runKindToBuffer } from '../exports/kinds/batch1/parity-testkit-spec';
import type { JwtPayload } from '../common/decorators/current-user.decorator';

const T = 'bajaj';
const NOW = new Date('2026-11-20T06:30:00Z'); // 20 Nov 2026 12:00 IST → October closed, November open
const at = (iso: string) => new Date(iso);

interface Cap {
  id: string; outletId: string; windowKey: string; status: string; receivedAt: Date; formValues: any;
}

const OUTLETS: FakeOutletRow[] = [
  // in scope, KYC-approved long ago
  { id: 'o1', clientId: T, outletCode: 'A1', typeCode: 'RET', partnerId: 'p1', partnerKycApprovedAt: [at('2026-01-10T00:00:00Z')], createdAt: at('2026-01-01T00:00:00Z') },
  { id: 'o2', clientId: T, outletCode: 'A2', typeCode: 'RET', partnerId: 'p2', partnerKycApprovedAt: [at('2026-01-10T00:00:00Z')], createdAt: at('2026-01-01T00:00:00Z') },
  { id: 'o3', clientId: T, outletCode: 'A3', typeCode: 'RET', partnerId: 'p3', partnerKycApprovedAt: [at('2026-01-10T00:00:00Z')], createdAt: at('2026-01-01T00:00:00Z') },
  { id: 'o4', clientId: T, outletCode: 'A4', typeCode: 'RET', partnerId: 'p4', partnerKycApprovedAt: [at('2026-01-10T00:00:00Z')], createdAt: at('2026-01-01T00:00:00Z') },
  // KYC approved on 10 Nov → not capturable in October, in scope in November
  { id: 'o5', clientId: T, outletCode: 'A5', typeCode: 'RET', partnerId: 'p5', partnerKycApprovedAt: [null, at('2026-11-10T00:00:00Z')], createdAt: at('2026-01-01T00:00:00Z') },
  // created 5 Nov → not in October
  { id: 'o6', clientId: T, outletCode: 'A6', typeCode: 'RET', partnerId: 'p6', partnerKycApprovedAt: [at('2026-11-05T00:00:00Z')], createdAt: at('2026-11-05T00:00:00Z') },
  // deactivated in September → in neither month
  { id: 'o7', clientId: T, outletCode: 'A7', typeCode: 'RET', partnerId: null, isActive: false, deactivatedAt: at('2026-09-15T00:00:00Z'), createdAt: at('2026-01-01T00:00:00Z') },
  // deactivated 20 Oct → in October (Missed), not in November
  { id: 'o8', clientId: T, outletCode: 'A8', typeCode: 'RET', partnerId: null, isActive: false, deactivatedAt: at('2026-10-20T00:00:00Z'), createdAt: at('2026-01-01T00:00:00Z') },
  // no KYC approval date on record (imported live) → creation date stands in
  { id: 'o9', clientId: T, outletCode: 'A9', typeCode: 'RET', partnerId: null, createdAt: at('2026-01-01T00:00:00Z') },
  // pending KYC today → never in scope
  { id: 'o10', clientId: T, outletCode: 'B1', typeCode: 'RET', partnerId: 'p10', isActive: false, partnerKycApprovedAt: [], createdAt: at('2026-01-01T00:00:00Z') },
  // wrong type
  { id: 'o11', clientId: T, outletCode: 'B2', typeCode: 'DIST', partnerId: null, createdAt: at('2026-01-01T00:00:00Z') },
];

const photo = (k: string) => ({ w1: `visibility-media/${T}/2026/${k}.jpg` });
const CAPTURES: Cap[] = [
  // go-live (September, portal)
  { id: 'sep', outletId: 'o1', windowKey: '2026-09-P1', status: 'APPROVED', receivedAt: at('2026-09-05T06:00:00Z'), formValues: photo('sep') },
  // October (closed)
  { id: 'oc1', outletId: 'o1', windowKey: '2026-10-P1', status: 'APPROVED', receivedAt: at('2026-10-05T06:00:00Z'), formValues: photo('oc1') },
  { id: 'oc2', outletId: 'o2', windowKey: '2026-10-P1', status: 'SUBMITTED', receivedAt: at('2026-10-06T06:00:00Z'), formValues: photo('oc2') },
  { id: 'oc3', outletId: 'o3', windowKey: '2026-10-P1', status: 'CHANGES_REQUESTED', receivedAt: at('2026-10-07T06:00:00Z'), formValues: photo('oc3') },
  // November (open)
  { id: 'nv1', outletId: 'o1', windowKey: '2026-11-P1', status: 'APPROVED', receivedAt: at('2026-11-05T06:00:00Z'), formValues: photo('nv1') },
  { id: 'nv2', outletId: 'o2', windowKey: '2026-11-P1', status: 'CHANGES_REQUESTED', receivedAt: at('2026-11-06T06:00:00Z'), formValues: photo('nv2') },
  { id: 'nv5', outletId: 'o5', windowKey: '2026-11-P1', status: 'REJECTED', receivedAt: at('2026-11-12T06:00:00Z'), formValues: photo('nv5') },
];

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const outletOf = (id: string) => OUTLETS.find((o) => o.id === id)!;

function matchCapture(c: Cap, w: any): boolean {
  if (!w) return true;
  for (const [k, cond] of Object.entries<any>(w)) {
    const val: any = k === 'outletCode' ? outletOf(c.outletId).outletCode : (c as any)[k];
    switch (k) {
      case 'AND': if (!cond.every((x: any) => matchCapture(c, x))) return false; break;
      case 'OR': if (!cond.some((x: any) => matchCapture(c, x))) return false; break;
      case 'NOT': if (matchCapture(c, cond)) return false; break;
      case 'clientId': if (cond !== T) return false; break;
      case 'outlet': if (!matchOutlet(outletOf(c.outletId), cond)) return false; break;
      case 'windowKey': case 'outletId': case 'status': case 'outletCode': case 'id':
        if (typeof cond === 'string') { if (val !== cond) return false; break; }
        if (cond.in && !cond.in.includes(val)) return false;
        if (cond.notIn && cond.notIn.includes(val)) return false;
        if (cond.startsWith && !String(val).startsWith(cond.startsWith)) return false;
        if (cond.gt !== undefined && !(val > cond.gt)) return false;
        break;
      default: throw new Error(`parity fake: unsupported capture key ${k}`);
    }
  }
  return true;
}

function capRow(c: Cap) {
  const o = outletOf(c.outletId);
  return {
    id: c.id, outletId: c.outletId, outletCode: o.outletCode, outletName: `Shop ${o.outletCode}`, windowKey: c.windowKey,
    status: c.status, geoFenceOk: true, distanceMeters: 10, captureAccuracy: 5, capturedAt: c.receivedAt, receivedAt: c.receivedAt,
    rejectionReasonCode: null, rejectionReason: null, formValues: c.formValues, formVersion: 1, currentVersion: 1,
    photoReviews: null, approvedByUserId: null, reviewedAt: null, submittedBySalesUserId: null, submittedBy: null,
    outlet: {
      name: `Shop ${o.outletCode}`, city: 'Pune', state: 'MH', programName: null, programCategory: null, partnerId: null,
      latitude: null, longitude: null, outletType: { name: 'Retailer' },
    },
  };
}

function fakePrisma() {
  return {
    $queryRaw: async (q: { sql: string; values: unknown[] }) => {
      const portal = CAPTURES.filter((c) => !JSON.stringify(c.formValues).includes('/vendor-import/'));
      if (q.sql.includes('MIN("receivedAt")')) {
        return [{ goLive: portal.reduce<Date | null>((m, c) => (!m || c.receivedAt < m ? c.receivedAt : m), null) }];
      }
      const keys = q.values.filter((v) => typeof v === 'string' && /-P\d$/.test(v as string));
      return [...new Set(CAPTURES.filter((c) => keys.includes(c.windowKey) && JSON.stringify(c.formValues).includes('/vendor-import/')).map((c) => c.windowKey))]
        .map((windowKey) => ({ windowKey }));
    },
    outlet: {
      findMany: async (a: any) =>
        OUTLETS.filter((o) => matchOutlet(o, a.where))
          .sort((x, y) => cmp(x.outletCode, y.outletCode) || cmp(x.id, y.id))
          .slice(0, a.take ?? Infinity)
          .map((o) => ({ ...o, name: `Shop ${o.outletCode}`, city: 'Pune', state: 'MH', programName: o.programName ?? null, programCategory: o.programCategory ?? null, outletType: { name: 'Retailer' } })),
      count: async (a: any) => OUTLETS.filter((o) => matchOutlet(o, a.where)).length,
    },
    visibilityCapture: {
      count: async (a: any) => CAPTURES.filter((c) => matchCapture(c, a.where)).length,
      findMany: async (a: any) => {
        let rows = CAPTURES.filter((c) => matchCapture(c, a.where));
        if (a.distinct) return [{ formVersion: 1 }];
        rows = [...rows].sort((x, y) => cmp(x.windowKey, y.windowKey) || cmp(outletOf(x.outletId).outletCode, outletOf(y.outletId).outletCode) || cmp(x.id, y.id));
        if (a.take) rows = rows.slice(0, a.take);
        return rows.map(capRow);
      },
    },
    visibilityCaptureSubmission: { findMany: async () => [] },
    visibilityImageHash: { findMany: async () => [] },
    visibilityForm: { findUnique: async () => ({ formSchema: { fields: [{ id: 'w1', type: 'CAMERA', label: 'Window', required: true, order: 1 }] } }) },
    visibilityFormVersion: { findMany: async () => [] },
    client: { findUnique: async () => null },
    clientDomain: { findMany: async () => [{ domain: 'rewards.example.in', isPrimary: true }] },
    channelPartner: { findMany: async () => [] },
    salesUser: { findMany: async () => [] },
    salesUserAssignment: { findMany: async () => [] },
    user: { findMany: async () => [] },
  };
}

const CONFIG = { geoFence: { radiusMeters: 50 }, frequencyPerMonth: 1, outletScope: ['RET'], programs: [], subPrograms: [] };
const tenant = { resolveVisibilityEnabled: async () => true };
const settings = { getEffectiveSettings: async () => ({ visibilityConfig: CONFIG }) };
const gifsy: JwtPayload = { sub: 'g', role: 'GIFSY_ADMIN', clientId: T, phone: '', name: '' };
const clientAdmin: JwtPayload = { sub: 'c', role: 'CLIENT_ADMIN', clientId: T, phone: '', name: '' };

async function excelCounts(month: string) {
  clearVisibilityGoLiveCache();
  const res = await runKindToBuffer(VISIBILITY_CAPTURES_KIND, { month }, {
    prisma: fakePrisma(),
    moduleRef: fakeModuleRef([[TenantService, tenant], [TenantSettingsService, settings]]),
    user: clientAdmin,
    now: NOW,
  });
  const wb = XLSX.read(res.buffer, { type: 'buffer' });
  const rows = (n: string) => (XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }) as unknown[][]).slice(1);
  const main = rows('Visibility');
  const statusCol = (XLSX.utils.sheet_to_json(wb.Sheets.Visibility, { header: 1 })[0] as string[]).indexOf('Status');
  const byStatus = (w: string) => main.filter((r) => r[statusCol] === w).length;
  const nc = rows('Not captured');
  const ncBy = (w: string) => nc.filter((r) => r[11] === w).length;
  return {
    approved: byStatus('Approved'),
    waiting: byStatus('Waiting for review'),
    needsRetake: byStatus('Needs re-take'),
    rejected: byStatus('Rejected'),
    closedNotApproved: byStatus('Not approved — window closed'),
    missed: ncBy('Missed'),
    notCaptured: ncBy('Not captured yet') + ncBy('Not started'),
    partOldApp: ncBy('No approved record — part of this window was on the old app'),
    missedOutlets: nc.filter((r) => r[11] === 'Missed').map((r) => r[0]).sort(),
  };
}

async function reportCounts(month: string) {
  clearVisibilityGoLiveCache();
  const svc = new VisibilityReportService(fakePrisma() as any, tenant as any, settings as any);
  const rep = await svc.gifsyReport(gifsy, { month });
  const missed = await svc.gifsyOutlets(gifsy, { month, status: 'MISSED' });
  const s = rep.summary;
  return {
    counts: {
      approved: s.approved, waiting: s.waiting, needsRetake: s.needsRetake, rejected: s.rejected,
      closedNotApproved: s.closedNotApproved, missed: s.missed, notCaptured: s.notCaptured, partOldApp: s.partOldApp,
      missedOutlets: missed.rows.map((r) => r.outletCode).sort(),
    },
    rep,
  };
}

describe('report screen ⇄ Excel parity (same fixture, same counts)', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('CLOSED month: the same Approved / Waiting / Not approved — window closed / Missed (existed + KYC-approved then)', async () => {
    const { counts, rep } = await reportCounts('2026-10');
    expect(counts).toEqual(await excelCounts('2026-10'));
    // o4 (no capture), o8 (deactivated during Oct), o9 (no KYC date → creation date) are Missed; o5 / o6 / o7 are not.
    expect(counts).toMatchObject({ approved: 1, waiting: 1, closedNotApproved: 1, missed: 3, missedOutlets: ['A4', 'A8', 'A9'] });
    expect(rep.notCounted.outOfScope).toBe(0);
    expect(rep.pastWindowScopeNote).toMatch(/use the date they were added instead/);
  });

  it('OPEN month: the same counts under today\'s rule (o5 / o6 in, o8 out)', async () => {
    const { counts, rep } = await reportCounts('2026-11');
    expect(counts).toEqual(await excelCounts('2026-11'));
    expect(counts).toMatchObject({ approved: 1, needsRetake: 1, rejected: 1, missed: 0, notCaptured: 4 });
    expect(rep.pastWindowScopeNote).toBeUndefined();
  });
});
