/**
 * Visibility report export kind (`visibility-captures`) — the 2026-11-20 redesign. Reads the workbook back with SheetJS
 * and asserts: headers (fixed + per-photo groups from the form LABELS), plain statuses, overall remark composed from
 * per-photo reasons, reviewer name/time, imported Source, Not-captured sheet (open → "Not captured yet", closed →
 * "Missed"), About counts = main sheet, absolute photo links on the primary portal host, formula-injection safety,
 * tenant isolation, paging, params + heavy rule, and the master-switch 403.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { TenantService } from '../../../tenant/tenant.service';
import { TenantSettingsService } from '../../../tenant/tenant-settings.service';
import { visibilityAddressableOutletWhere } from '../../../visibility/visibility-report.service';
import {
  VISIBILITY_CAPTURES_KIND,
  VISIBILITY_HISTORY_HEADERS,
  VISIBILITY_NOT_CAPTURED_HEADERS,
  VISIBILITY_LINK_LIMIT,
  VISIBILITY_REPORT_BASE_HEADERS,
  planPhotoColumns,
} from './visibility-captures';
import { fakeModuleRef, readBack, runKindToBuffer } from './parity-testkit-spec';

/* eslint-disable @typescript-eslint/no-explicit-any */

const T = 'bajaj';

interface Outlet {
  id: string; clientId: string; outletCode: string; name: string; city: string; state: string;
  programName: string | null; programCategory: string | null; partnerId: string | null;
  latitude?: number | null; longitude?: number | null; type: string; inScope: boolean;
  createdAt?: Date; deactivatedAt?: Date | null;
}
interface Capture {
  id: string; clientId: string; outletId: string; outletCode: string; outletName: string; windowKey: string;
  status: string; geoFenceOk: boolean | null; distanceMeters: number | null; captureAccuracy: number | null;
  capturedAt: Date | null; receivedAt: Date; rejectionReasonCode: string | null; rejectionReason: string | null;
  formValues: any; formVersion: number; currentVersion: number; photoReviews: any; approvedByUserId: string | null;
  reviewedAt: Date | null; submittedBySalesUserId: string | null;
}
interface Submission {
  clientId: string; captureId: string; windowKey: string; version: number; formValues: any; photoReviews: any;
  formVersion: number; createdAt: Date;
}
interface Db {
  outlets: Outlet[];
  captures: Capture[];
  submissions: Submission[];
  hashes: { clientId: string; captureId: string; hash: string }[];
  versions: { clientId: string; version: number; formSchema: any }[];
  currentForm: any;
  users: { id: string; name: string }[];
  sales: { id: string; clientId: string; reportingToId: string | null; isActive: boolean; deletedAt: Date | null; employeeCode: string; name: string; level: string }[];
  assignments: { outletId: string; salesUserId: string; unassignedAt: Date | null }[];
  domains: { clientId: string; domain: string; isPrimary: boolean }[];
  features?: Record<string, unknown>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function fakePrisma(db: Db) {
  const calls: Record<string, any[]> = {};
  const log = (k: string, a: unknown) => (calls[k] ??= []).push(a);
  const outletRel = (id: string) => {
    const o = db.outlets.find((x) => x.id === id)!;
    return {
      name: o.name, city: o.city, state: o.state, programName: o.programName, programCategory: o.programCategory,
      partnerId: o.partnerId, latitude: o.latitude ?? null, longitude: o.longitude ?? null, outletType: { name: o.type },
    };
  };
  const ownCaptures = () => db.captures.filter((c) => c.clientId === T);
  const matchCapture = (c: Capture, w: any): boolean => {
    if (w.AND) return w.AND.every((x: any) => matchCapture(c, x));
    if (w.OR) return w.OR.some((x: any) => matchCapture(c, x));
    for (const [k, v] of Object.entries<any>(w)) {
      const val = (c as any)[k];
      if (v && typeof v === 'object' && 'in' in v) { if (!v.in.includes(val)) return false; }
      else if (v && typeof v === 'object' && 'gt' in v) { if (!(val > v.gt)) return false; }
      else if (val !== v) return false;
    }
    return true;
  };
  return {
    calls,
    client: { findUnique: async () => (db.features ? { features: db.features } : null) },
    clientDomain: {
      findMany: async (a: any) => db.domains.filter((d) => d.clientId === a.where.clientId).map(({ domain, isPrimary }) => ({ domain, isPrimary })),
    },
    visibilityForm: { findUnique: async (a: any) => (a.where.clientId === T ? { formSchema: db.currentForm } : null) },
    visibilityFormVersion: {
      findMany: async (a: any) => {
        log('visibilityFormVersion.findMany', a);
        return db.versions.filter((v) => v.clientId === a.where.clientId && a.where.version.in.includes(v.version));
      },
    },
    visibilityCapture: {
      count: async (a: any) => db.captures.filter((c) => matchCapture(c, a.where)).length,
      findFirst: async (a: any) => {
        log('visibilityCapture.findFirst', a);
        const rows = ownCaptures().filter((c) => c.submittedBySalesUserId !== null).sort((x, y) => cmp(x.windowKey, y.windowKey));
        return rows[0] ? { windowKey: rows[0].windowKey } : null;
      },
      findMany: async (a: any) => {
        log('visibilityCapture.findMany', a);
        let rows = db.captures.filter((c) => matchCapture(c, a.where));
        if (a.distinct) return [...new Set(rows.map((r) => r.formVersion))].map((formVersion) => ({ formVersion }));
        if (a.where.outletId) return rows.map((r) => ({ outletId: r.outletId, windowKey: r.windowKey }));
        rows = [...rows].sort((x, y) => cmp(x.windowKey, y.windowKey) || cmp(x.outletCode, y.outletCode) || cmp(x.id, y.id));
        if (a.take) rows = rows.slice(0, a.take);
        return rows.map(({ clientId: _c, ...r }) => ({ ...r, outlet: outletRel(r.outletId) }));
      },
    },
    visibilityCaptureSubmission: {
      findMany: async (a: any) => {
        log('visibilityCaptureSubmission.findMany', a);
        const base = a.where.AND ? a.where.AND[0] : a.where;
        const ks = a.where.AND ? a.where.AND[1].OR : null;
        let rows = db.submissions.filter((s) => s.clientId === base.clientId && base.windowKey.in.includes(s.windowKey));
        if (ks) {
          rows = rows.filter((s) =>
            s.windowKey > ks[0].windowKey.gt ||
            (s.windowKey === ks[1].windowKey && s.captureId > ks[1].captureId.gt) ||
            (s.windowKey === ks[2].windowKey && s.captureId === ks[2].captureId && s.version > ks[2].version.gt));
        }
        rows = [...rows].sort((x, y) => cmp(x.windowKey, y.windowKey) || cmp(x.captureId, y.captureId) || x.version - y.version);
        if (a.take) rows = rows.slice(0, a.take);
        return rows.map((s) => {
          const c = db.captures.find((x) => x.id === s.captureId)!;
          return {
            ...s,
            capture: {
              outletCode: c.outletCode, outletName: c.outletName, outlet: { name: outletRel(c.outletId).name },
              currentVersion: c.currentVersion, status: c.status,
              approvedByUserId: c.approvedByUserId, reviewedAt: c.reviewedAt, rejectionReason: c.rejectionReason,
              rejectionReasonCode: c.rejectionReasonCode,
            },
          };
        });
      },
    },
    visibilityImageHash: {
      findMany: async (a: any) =>
        db.hashes
          .filter((h) => h.clientId === a.where.clientId)
          .filter((h) => !a.where.captureId || a.where.captureId.in.includes(h.captureId))
          .filter((h) => !a.where.hash || a.where.hash.in.includes(h.hash))
          .map((h) => ({ hash: h.hash, captureId: h.captureId })),
    },
    channelPartner: { findMany: async () => [] },
    outlet: {
      findMany: async (a: any) => {
        log('outlet.findMany', a);
        const ks = a.where.AND?.[1]?.OR?.[0]?.outletCode ? a.where.AND[1].OR : null;
        let rows = db.outlets.filter((o) => o.clientId === T && o.inScope);
        if (ks) rows = rows.filter((o) => o.outletCode > ks[0].outletCode.gt || (o.outletCode === ks[1].outletCode && o.id > ks[1].id.gt));
        rows = [...rows].sort((x, y) => cmp(x.outletCode, y.outletCode) || cmp(x.id, y.id)).slice(0, a.take);
        return rows.map((o) => ({ ...o, createdAt: o.createdAt ?? new Date('2025-01-01T00:00:00Z'), deactivatedAt: o.deactivatedAt ?? null, outletType: { name: o.type } }));
      },
    },
    salesUser: {
      findMany: async (a: any) =>
        db.sales.filter((s) => s.clientId === a.where.clientId).map((s) => ({
          id: s.id, reportingToId: s.reportingToId, isActive: s.isActive, deletedAt: s.deletedAt, employeeCode: s.employeeCode,
          user: { name: s.name }, hierarchyLevel: { name: s.level },
        })),
    },
    salesUserAssignment: {
      findMany: async (a: any) =>
        db.assignments.filter((x) => {
          const su = db.sales.find((s) => s.id === x.salesUserId);
          const wantActive = a.where.salesUser?.isActive === true;
          return x.unassignedAt === null && a.where.outletId.in.includes(x.outletId) && !!su && su.deletedAt === null && (!wantActive || su.isActive);
        }),
    },
    user: {
      findMany: async (a: any) => {
        log('user.findMany', a);
        return db.users.filter((u) => a.where.id.in.includes(u.id));
      },
    },
  };
}

const FORM = {
  captureGpsOnSubmit: false,
  fields: [
    { id: 'w1', type: 'CAMERA', label: 'Window 1', required: true, order: 1, geoFenceRequired: true },
    { id: 'note', type: 'TEXT', label: 'Note', required: false, order: 2 },
    { id: 'w2', type: 'CAMERA', label: 'Window 2', required: true, order: 3, visibleWhen: { fieldId: '__subProgram__', op: 'eq', value: 'Privilege' } },
  ],
};

const outlet = (n: number, extra: Partial<Outlet> = {}): Outlet => ({
  id: `o${n}`, clientId: T, outletCode: `A00${n}`, name: `Shop ${n}`, city: 'Pune', state: 'MH', programName: 'RLP',
  programCategory: 'Elite', partnerId: null, type: 'Retailer', inScope: true, ...extra,
});

const at = (iso: string) => new Date(iso);

function baseDb(): Db {
  const rev = (status: string, by: string, iso: string, extra: Record<string, string> = {}) => ({ status, reviewedAt: iso, reviewedByUserId: by, ...extra });
  return {
    outlets: [outlet(1), outlet(2, { programCategory: 'Privilege', name: 'Shop 2 (renamed)' }), outlet(3), outlet(4, { name: '=HYPERLINK("http://evil")' }), outlet(5), outlet(6, { inScope: false })],
    captures: [
      {
        id: 'c1', clientId: T, outletId: 'o1', outletCode: 'A001', outletName: 'Shop 1', windowKey: '2026-11-P1', status: 'APPROVED',
        geoFenceOk: true, distanceMeters: 34.4, captureAccuracy: 12, capturedAt: at('2026-11-05T09:30:00Z'), receivedAt: at('2026-11-05T09:31:00Z'),
        rejectionReasonCode: null, rejectionReason: null, formVersion: 3, currentVersion: 1, submittedBySalesUserId: 'su-rep',
        formValues: { w1: { key: 'visibility-media/bajaj/a1.jpg', geo: { lat: 18.5, lng: 73.8, accuracy: 9 } }, note: 'ok' },
        photoReviews: { w1: rev('APPROVED', 'u-admin', '2026-11-06T04:00:00.000Z') }, approvedByUserId: 'u-admin', reviewedAt: at('2026-11-06T04:00:00Z'),
      },
      {
        id: 'c2', clientId: T, outletId: 'o2', outletCode: 'A002', outletName: 'Shop 2', windowKey: '2026-11-P1', status: 'CHANGES_REQUESTED',
        geoFenceOk: false, distanceMeters: 410, captureAccuracy: 20, capturedAt: at('2026-11-07T10:00:00Z'), receivedAt: at('2026-11-07T10:01:00Z'),
        rejectionReasonCode: null, rejectionReason: null, formVersion: 3, currentVersion: 2, submittedBySalesUserId: 'su-rep',
        formValues: { w1: 'visibility-media/bajaj/a2-w1.jpg', w2: 'visibility-media/bajaj/a2-w2.jpg' },
        photoReviews: {
          w1: rev('REJECTED', 'u-admin', '2026-11-08T05:00:00.000Z', { reasonCode: 'BLURRY', reason: 'too dark' }),
          w2: rev('APPROVED', 'u-other', '2026-11-08T06:30:00.000Z'),
        },
        approvedByUserId: null, reviewedAt: at('2026-11-08T06:30:00Z'),
      },
      {
        id: 'c3', clientId: T, outletId: 'o3', outletCode: 'A003', outletName: 'Shop 3', windowKey: '2026-11-P1', status: 'APPROVED',
        geoFenceOk: null, distanceMeters: null, captureAccuracy: null, capturedAt: null, receivedAt: at('2026-11-03T06:00:00Z'),
        rejectionReasonCode: null, rejectionReason: null, formVersion: 3, currentVersion: 1, submittedBySalesUserId: null,
        formValues: { w1: 'visibility-media/bajaj/vendor-import/prod/b1/A003/2026-11_v1.jpg' },
        photoReviews: null, approvedByUserId: 'u-gifsy', reviewedAt: at('2026-11-04T06:00:00Z'),
      },
      {
        id: 'c4', clientId: T, outletId: 'o4', outletCode: 'A004', outletName: '=HYPERLINK("http://evil")', windowKey: '2026-11-P1', status: 'REJECTED',
        geoFenceOk: true, distanceMeters: 10, captureAccuracy: 5, capturedAt: null, receivedAt: at('2026-11-09T06:00:00Z'),
        rejectionReasonCode: 'WRONG_OUTLET', rejectionReason: null, formVersion: 3, currentVersion: 1, submittedBySalesUserId: 'su-rep',
        formValues: { w1: 'visibility-media/bajaj/a4.jpg' },
        photoReviews: { w1: rev('REJECTED', 'u-admin', '2026-11-10T06:00:00.000Z', { reasonCode: 'WRONG_OUTLET' }) },
        approvedByUserId: 'u-admin', reviewedAt: at('2026-11-10T06:00:00Z'),
      },
      // Another tenant — must never appear.
      {
        id: 'x1', clientId: 'other', outletId: 'o1', outletCode: 'A001', outletName: 'OTHER-TENANT', windowKey: '2026-11-P1', status: 'APPROVED',
        geoFenceOk: null, distanceMeters: null, captureAccuracy: null, capturedAt: null, receivedAt: at('2026-11-03T06:00:00Z'),
        rejectionReasonCode: null, rejectionReason: null, formVersion: 3, currentVersion: 1, submittedBySalesUserId: null,
        formValues: { w1: 'k' }, photoReviews: null, approvedByUserId: null, reviewedAt: null,
      },
    ],
    submissions: [
      { clientId: T, captureId: 'c2', windowKey: '2026-11-P1', version: 1, formValues: { w1: 'visibility-media/bajaj/a2-old.jpg', w2: 'visibility-media/bajaj/a2-w2.jpg' }, photoReviews: null, formVersion: 3, createdAt: at('2026-11-06T10:00:00Z') },
      { clientId: T, captureId: 'c2', windowKey: '2026-11-P1', version: 2, formValues: { w1: 'visibility-media/bajaj/a2-w1.jpg', w2: 'visibility-media/bajaj/a2-w2.jpg' }, photoReviews: {
        w1: rev('REJECTED', 'u-admin', '2026-11-08T05:00:00.000Z', { reasonCode: 'BLURRY', reason: 'too dark' }),
        w2: rev('APPROVED', 'u-other', '2026-11-08T06:30:00.000Z'),
      }, formVersion: 3, createdAt: at('2026-11-07T10:01:00Z') },
    ],
    hashes: [
      { clientId: T, captureId: 'c1', hash: 'H1' },
      { clientId: T, captureId: 'c4', hash: 'H1' },
      { clientId: T, captureId: 'c2', hash: 'H2' },
    ],
    versions: [{ clientId: T, version: 3, formSchema: FORM }],
    currentForm: FORM,
    users: [{ id: 'u-admin', name: 'Asha Admin' }, { id: 'u-other', name: 'Ravi Reviewer' }, { id: 'u-gifsy', name: 'Gifsy Ops' }],
    sales: [
      { id: 'su-rep', clientId: T, reportingToId: 'su-vacant', isActive: true, deletedAt: null, employeeCode: 'E100', name: 'Rahul Rep', level: 'ISR' },
      { id: 'su-vacant', clientId: T, reportingToId: 'su-so', isActive: false, deletedAt: null, employeeCode: 'E200', name: 'Vacant SO', level: 'SO' },
      { id: 'su-so', clientId: T, reportingToId: null, isActive: true, deletedAt: null, employeeCode: 'E300', name: 'Sunil Manager', level: 'ASM' },
    ],
    assignments: [
      { outletId: 'o5', salesUserId: 'su-rep', unassignedAt: null },
      { outletId: 'o5', salesUserId: 'su-vacant', unassignedAt: null }, // inactive rep → never listed
    ],
    domains: [
      { clientId: T, domain: 'uat-bajaj.gifsy.in', isPrimary: false },
      { clientId: T, domain: 'rewards.bajaj.example', isPrimary: true },
    ],
  };
}

const user: JwtPayload = { sub: 'a', role: 'CLIENT_ADMIN', clientId: T, phone: '', name: '' };
const SCOPE = ['RET'];
const services = (enabled = true, freq = 1) =>
  fakeModuleRef([
    [TenantService, { resolveVisibilityEnabled: async () => enabled }],
    [TenantSettingsService, { getEffectiveSettings: async () => ({ visibilityConfig: { geoFence: { radiusMeters: 50 }, frequencyPerMonth: freq, outletScope: SCOPE, programs: [], subPrograms: [] } }) }],
  ]);

const NOW = new Date('2026-11-20T06:00:00Z');

async function run(db: Db, params: Record<string, unknown> = {}, now = NOW, freq = 1) {
  const prisma = fakePrisma(db);
  const res = await runKindToBuffer(VISIBILITY_CAPTURES_KIND, params, { prisma, moduleRef: services(true, freq), user, now });
  const back = readBack(res.buffer);
  const sheet = (n: string) => back.rows[n] as unknown[][];
  const header = sheet('Visibility')[0] as string[];
  const rowOf = (code: string) => {
    const r = sheet('Visibility').find((x) => x[0] === code) as unknown[];
    return (h: string) => {
      const i = header.indexOf(h);
      if (i < 0) throw new Error(`no column ${h}`);
      return r[i];
    };
  };
  return { ...res, back, sheet, header, rowOf, prisma };
}

const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.TENANT_LINK_ENV = 'production';
  delete process.env.PLATFORM_DOMAIN;
});
afterAll(() => {
  process.env = savedEnv;
});

describe('visibility report export (visibility-captures)', () => {
  it('sheets + headers: fixed columns, then one 6-column group per CAMERA field named by its LABEL', async () => {
    const { back, header, sheet } = await run(baseDb());
    expect(back.names).toEqual(['Visibility', 'Review history', 'Not captured', 'About']);
    expect(header).toEqual([
      ...VISIBILITY_REPORT_BASE_HEADERS,
      'Window 1 – Photo', 'Window 1 – Decision', 'Window 1 – Reason', 'Window 1 – Reviewed by', 'Window 1 – Reviewed on', 'Window 1 – Location',
      'Window 2 – Photo', 'Window 2 – Decision', 'Window 2 – Reason', 'Window 2 – Reviewed by', 'Window 2 – Reviewed on', 'Window 2 – Location',
    ]);
    expect(sheet('Review history')[0]).toEqual([...VISIBILITY_HISTORY_HEADERS]);
    expect(sheet('Not captured')[0]).toEqual([...VISIBILITY_NOT_CAPTURED_HEADERS]);
    expect(JSON.stringify(back.rows)).not.toContain('OTHER-TENANT');
  });

  it('plain statuses, rep + first ACTIVE manager (vacant level skipped), dates in IST words, duplicate Yes/No', async () => {
    const { rowOf } = await run(baseDb());
    const a1 = rowOf('A001');
    expect(a1('Status')).toBe('Approved');
    expect(a1('Captured by')).toBe('Rahul Rep');
    expect(a1('Rep code')).toBe('E100');
    expect(a1('Rep designation')).toBe('ISR');
    expect(a1('Manager')).toBe('Sunil Manager (ASM)');
    expect(a1('Captured on')).toBe('05 Nov 2026, 3:00 pm');
    expect(a1('Source')).toBe('Portal app');
    expect(a1('Location check')).toBe('Inside fence (34 m, ±12 m)');
    expect(a1('Duplicate photo')).toBe('Yes');
    expect(a1('Re-takes')).toBe(0);
    expect(a1('Reviewed by')).toBe('Asha Admin');
    expect(a1('Outlet Type')).toBe('Retailer');
    expect(a1('Programme')).toBe('RLP');
    expect(a1('Sub-programme')).toBe('Elite');
    expect(a1('Window 2 – Decision')).toBe('Not applicable'); // Privilege-only photo at an Elite outlet
    expect(rowOf('A002')('Status')).toBe('Needs re-take');
    expect(rowOf('A002')('Duplicate photo')).toBe('No');
    expect(rowOf('A004')('Status')).toBe('Rejected');
  });

  it('CHANGES_REQUESTED: per-photo decisions/reasons/reviewers + Overall remark composed from the rejected photos', async () => {
    const { rowOf } = await run(baseDb());
    const a2 = rowOf('A002');
    expect(a2('Window 1 – Decision')).toBe('Rejected');
    expect(a2('Window 1 – Reason')).toBe('too dark');
    expect(a2('Window 1 – Reviewed by')).toBe('Asha Admin');
    expect(a2('Window 1 – Reviewed on')).toBe('08 Nov 2026, 10:30 am');
    expect(a2('Window 2 – Decision')).toBe('Approved');
    expect(a2('Window 2 – Reviewed by')).toBe('Ravi Reviewer');
    expect(a2('Overall remark')).toBe('Re-take needed: Window 1: too dark');
    // Capture-level reviewer = the LATEST per-photo review.
    expect(a2('Reviewed by')).toBe('Ravi Reviewer');
    expect(a2('Reviewed on')).toBe('08 Nov 2026, 12:00 pm');
    expect(a2('Re-takes')).toBe(1);
    expect(a2('Location check')).toBe('Outside fence (410 m, ±20 m)');
  });

  it('whole-capture REJECTED: Overall remark = the reason code label; reason code label fills the photo Reason', async () => {
    const { rowOf } = await run(baseDb());
    const a4 = rowOf('A004');
    expect(a4('Overall remark')).toBe('Wrong outlet');
    expect(a4('Window 1 – Reason')).toBe('Wrong outlet');
  });

  it('imported old-app record: Source label, no rep, location "Not recorded", decision from the whole-capture approval', async () => {
    const { rowOf } = await run(baseDb());
    const a3 = rowOf('A003');
    expect(a3('Source')).toBe('Imported (old app)');
    expect(a3('Captured by')).toBe('');
    expect(a3('Manager')).toBe('');
    expect(a3('Location check')).toBe('Not recorded (old app)');
    expect(a3('Window 1 – Decision')).toBe('Approved');
    expect(a3('Window 1 – Reviewed by')).toBe('Gifsy Ops');
    expect(a3('Reviewed by')).toBe('Gifsy Ops');
    expect(a3('Window 2 – Decision')).toBe('Not applicable');
    expect(a3('Window 1 – Location')).toBe('Not recorded (old app)');
  });

  it('photo cells are clickable "Open photo" links on the PRIMARY portal host (never the uat host), key URL-encoded', async () => {
    const { rowOf, back, header, sheet } = await run(baseDb());
    expect(rowOf('A001')('Window 1 – Photo')).toBe('Open photo');
    const col = header.indexOf('Window 1 – Photo');
    const r = sheet('Visibility').findIndex((x) => x[0] === 'A001');
    const addr = XLSX.utils.encode_cell({ r, c: col });
    expect(back.links.Visibility[addr]).toBe(
      `https://rewards.bajaj.example/visibility/photo?key=${encodeURIComponent('visibility-media/bajaj/a1.jpg')}`,
    );
    const all = Object.values(back.links.Visibility);
    expect(all.length).toBe(5); // a1, a2 w1+w2, a3, a4
    for (const l of all) expect(l.startsWith('https://rewards.bajaj.example/visibility/photo?key=visibility-media%2Fbajaj%2F')).toBe(true);
  });

  it('no primary domain → links fall back to <slug>.gifsy.in', async () => {
    const db = baseDb();
    db.domains = [{ clientId: T, domain: 'uat-bajaj.gifsy.in', isPrimary: false }];
    const { back } = await run(db);
    for (const l of Object.values(back.links.Visibility)) expect(l.startsWith('https://bajaj.gifsy.in/visibility/photo?key=')).toBe(true);
  });

  it('formula-injection safety: an outlet name starting with "=" is written as text', async () => {
    const { rowOf } = await run(baseDb());
    expect(rowOf('A004')('Outlet Name')).toBe('\'=HYPERLINK("http://evil")');
  });

  it('Review history: one row per version per photo; older version without a snapshot = "Not recorded"', async () => {
    const { sheet, back } = await run(baseDb());
    const rows = sheet('Review history').slice(1);
    expect(rows).toHaveLength(4); // c2 v1 (2 photos) + c2 v2 (2 photos); imported/no-submission captures have none
    const v1w1 = rows.find((r) => r[3] === 1 && r[5] === 'Window 1')!;
    expect(v1w1[7]).toBe('Not recorded');
    const v2w1 = rows.find((r) => r[3] === 2 && r[5] === 'Window 1')!;
    expect(v2w1.slice(7)).toEqual(['Rejected', 'too dark', 'Asha Admin', '08 Nov 2026, 10:30 am']);
    expect(v2w1[6]).toBe('Open photo');
    expect(v2w1[1]).toBe('Shop 2 (renamed)'); // current outlet name, same as the main sheet
    expect(Object.values(back.links['Review history'])).toContain(
      `https://rewards.bajaj.example/visibility/photo?key=${encodeURIComponent('visibility-media/bajaj/a2-old.jpg')}`,
    );
  });

  it('Not captured: in-scope outlets with no capture; OPEN window → "Not captured yet" with assigned rep + manager', async () => {
    const { sheet, prisma } = await run(baseDb());
    const rows = sheet('Not captured').slice(1);
    expect(rows).toEqual([
      ['A005', 'Shop 5', 'Retailer', 'RLP', 'Elite', 'Pune', 'MH', 'Rahul Rep', 'E100', 'Sunil Manager (ASM)', '2026-11-P1', 'Not captured yet'],
    ]);
    // The SAME in-scope rule as the report tiles, narrowed to outlets alive during the window (IST November).
    expect(prisma.calls['outlet.findMany'][0].where).toEqual(
      visibilityAddressableOutletWhere(T, SCOPE, { programs: [], subPrograms: [] }, {
        start: new Date('2026-10-31T18:30:00Z'), end: new Date('2026-11-30T18:30:00Z'),
      }),
    );
  });

  it('Not captured: a month BEFORE the portal go-live (imported history) → one "Not tracked" row, explained on About', async () => {
    const db = baseDb(); // first portal capture = 2026-11 → go-live November
    const { sheet, rowCount } = await run(db, { month: '2026-10' });
    expect(sheet('Visibility')).toHaveLength(1); // header only: no October captures
    const rows = sheet('Not captured').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe("Not tracked for imported months — the old app's records only include approved visits");
    expect(rows[0][11]).toBe('Not tracked');
    expect(rowCount).toBe(1);
    const about = Object.fromEntries(sheet('About').slice(1).map((r) => [String(r[0]).trim(), r[1]]));
    expect(String(about['NOT CAPTURED'])).toContain('portal went live in November 2026');
    expect(about['Missed (window closed, no capture)']).toBeUndefined();
  });

  it('Not captured: a CLOSED portal month → "Missed" only for outlets that existed and were active then', async () => {
    const db = baseDb();
    // Portal go-live earlier (September) so October is a tracked portal month.
    db.captures.push({ ...db.captures[0], id: 'sep1', windowKey: '2026-09-P1', outletCode: 'A001' });
    db.outlets.find((o) => o.id === 'o5')!.createdAt = new Date('2026-11-05T00:00:00Z'); // created after October
    db.outlets.find((o) => o.id === 'o3')!.deactivatedAt = new Date('2026-09-15T00:00:00Z'); // gone before October
    db.outlets.find((o) => o.id === 'o4')!.deactivatedAt = new Date('2026-10-20T00:00:00Z'); // active during October
    const { sheet, prisma } = await run(db, { month: '2026-10' });
    const rows = sheet('Not captured').slice(1);
    expect(rows.map((r) => [r[0], r[10], r[11]])).toEqual([
      ['A001', '2026-10-P1', 'Missed'],
      ['A002', '2026-10-P1', 'Missed'],
      ['A004', '2026-10-P1', 'Missed'],
    ]);
    // The outlet query is the tiles' rule narrowed to outlets alive during October (IST).
    expect(prisma.calls['outlet.findMany'][0].where).toEqual(
      visibilityAddressableOutletWhere(T, SCOPE, { programs: [], subPrograms: [] }, {
        start: new Date('2026-09-30T18:30:00Z'), end: new Date('2026-10-31T18:30:00Z'),
      }),
    );
  });

  it('Not captured: a window that has not begun → "Not started" (twice-a-month programme, early in the month)', async () => {
    const db = baseDb();
    const { sheet } = await run(db, {}, new Date('2026-11-10T06:00:00Z'), 2);
    const rows = sheet('Not captured').slice(1).map((r) => [r[0], r[10], r[11]]);
    expect(rows).toContainEqual(['A005', '2026-11-P1', 'Not captured yet']);
    expect(rows).toContainEqual(['A005', '2026-11-P2', 'Not started']);
    expect(rows).toContainEqual(['A001', '2026-11-P2', 'Not started']);
    expect(rows.some((r) => r[1] === '2026-11-P3')).toBe(false);
  });

  it('400: a window the programme frequency does not have (P2 on a monthly programme, no captures)', async () => {
    await expect(run(baseDb(), { windowKey: '2026-11-P2' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('carried-forward approvals: "Approved (earlier version)"; a waiting row shows no reviewer older than its submission', async () => {
    const db = baseDb();
    db.outlets.push(outlet(7, { programCategory: 'Privilege' }));
    db.captures.push({
      ...db.captures[1], id: 'c7', outletId: 'o7', outletCode: 'A007', outletName: 'Shop 7', status: 'SUBMITTED', currentVersion: 2,
      receivedAt: at('2026-11-12T06:00:00Z'), reviewedAt: null, approvedByUserId: null,
      formValues: { w1: 'visibility-media/bajaj/a7-w1-new.jpg', w2: 'visibility-media/bajaj/a7-w2.jpg' },
      photoReviews: { w2: { status: 'APPROVED', reviewedAt: '2026-11-11T06:00:00.000Z', reviewedByUserId: 'u-other' } },
    });
    const { rowOf } = await run(db);
    const a7 = rowOf('A007');
    expect(a7('Status')).toBe('Waiting for review');
    expect(a7('Reviewed by')).toBe('');
    expect(a7('Reviewed on')).toBe('');
    expect(a7('Window 1 – Decision')).toBe('Pending');
    expect(a7('Window 2 – Decision')).toBe('Approved (earlier version)');
    expect(a7('Window 2 – Reviewed by')).toBe('Ravi Reviewer');
  });

  it('hyperlink limit: beyond the per-sheet cap the URL is written as text and About says so (no silent cap)', async () => {
    const saved = VISIBILITY_LINK_LIMIT.perSheet;
    VISIBILITY_LINK_LIMIT.perSheet = 2;
    try {
      const { back, sheet, header } = await run(baseDb());
      expect(Object.keys(back.links.Visibility)).toHaveLength(2);
      const col = header.indexOf('Window 1 – Photo');
      const texts = sheet('Visibility').slice(1).map((r) => String(r[col])).filter((v) => v.startsWith('https://'));
      expect(texts.length).toBeGreaterThan(0);
      expect(texts[0]).toMatch(/^https:\/\/rewards\.bajaj\.example\/visibility\/photo\?key=/);
      const about = Object.fromEntries(sheet('About').slice(1).map((r) => [String(r[0]).trim(), r[1]]));
      expect(String(about['PHOTO LINK LIMIT'])).toContain('show the full photo address as text');
    } finally {
      VISIBILITY_LINK_LIMIT.perSheet = saved;
    }
  });

  it('About: status counts equal the Visibility sheet; scope + photo-link note present', async () => {
    const { sheet } = await run(baseDb());
    const about = Object.fromEntries(sheet('About').slice(1).map((r) => [String(r[0]).trim(), r[1]]));
    const main = sheet('Visibility').slice(1);
    const count = (w: string) => main.filter((r) => r[9] === w).length;
    expect(about['Visits in the Visibility sheet']).toBe(main.length);
    const counts = sheet('About').slice(1).filter((r) => String(r[0]).startsWith('  ')).map((r) => [String(r[0]).trim(), r[1]]);
    expect(Object.fromEntries(counts)).toEqual({
      Approved: count('Approved'),
      'Waiting for review': count('Waiting for review'),
      'Needs re-take': count('Needs re-take'),
      Rejected: count('Rejected'),
      'of which imported from the old app': 1,
    });
    expect(about['Covers']).toBe('November 2026 — every window of the month');
    expect(String(about['PHOTO LINKS'])).toContain('rewards.bajaj.example');
    expect(about['Not captured yet (window still open)']).toBe(1);
  });

  it('pages over 2,000 captures (keyset) and reads reviewer names once per page, not per row', async () => {
    const db = baseDb();
    for (let i = 0; i < 2300; i++) {
      db.outlets.push(outlet(1000 + i, { outletCode: `B${String(i).padStart(5, '0')}`, inScope: false }));
      db.captures.push({
        ...db.captures[0], id: `b${String(i).padStart(5, '0')}`, outletId: `o${1000 + i}`, outletCode: `B${String(i).padStart(5, '0')}`,
      });
    }
    const { sheet, prisma } = await run(db);
    expect(sheet('Visibility')).toHaveLength(1 + 4 + 2300);
    const pages = prisma.calls['visibilityCapture.findMany'].filter((a: any) => !a.distinct && !a.where.outletId);
    expect(pages).toHaveLength(2);
    expect(prisma.calls['user.findMany'].length).toBeLessThanOrEqual(3);
  });

  it('one window → light + window file name; month → heavy (Downloads page)', async () => {
    const w = await run(baseDb(), { windowKey: '2026-11-P1' });
    expect(w.heavy).toBe(false);
    expect(w.fileName).toBe('visibility_report_2026-11-P1_2026-11-20.xlsx');
    const m = await run(baseDb(), {});
    expect(m.heavy).toBe(true);
    expect(m.fileName).toBe('visibility_report_2026-11_2026-11-20.xlsx');
  });

  it('parseParams: month / windowKey validated; blank = default; requestOrigin kept for local links', () => {
    expect(VISIBILITY_CAPTURES_KIND.parseParams({}, user)).toEqual({});
    expect(VISIBILITY_CAPTURES_KIND.parseParams({ windowKey: '  ' }, user)).toEqual({});
    expect(VISIBILITY_CAPTURES_KIND.parseParams({ windowKey: '2026-09-P1' }, user)).toEqual({ windowKey: '2026-09-P1' });
    expect(VISIBILITY_CAPTURES_KIND.parseParams({ month: '2026-09', requestOrigin: 'http://localhost:3000' }, user)).toEqual({
      month: '2026-09', requestOrigin: 'http://localhost:3000',
    });
    expect(() => VISIBILITY_CAPTURES_KIND.parseParams({ month: '2026-13' }, user)).toThrow(BadRequestException);
    const ist = new Date(Date.now() + 330 * 60_000);
    const next = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1));
    const nextMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
    expect(() => VISIBILITY_CAPTURES_KIND.parseParams({ month: nextMonth }, user)).toThrow('future month');
    expect(() => VISIBILITY_CAPTURES_KIND.parseParams({ windowKey: `${nextMonth}-P1` }, user)).toThrow('future month');
    expect(() => VISIBILITY_CAPTURES_KIND.parseParams({ windowKey: '2026-W45' }, user)).toThrow(BadRequestException);
    expect(() => VISIBILITY_CAPTURES_KIND.parseParams({ month: '2026-10', windowKey: '2026-11-P1' }, user)).toThrow(BadRequestException);
    expect(() => VISIBILITY_CAPTURES_KIND.parseParams({ windowKey: ['a'] }, user)).toThrow('windowKey must be a string');
    expect(VISIBILITY_CAPTURES_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'visibility:read' });
  });

  it('403 when the tenant\'s Visibility switch is off (worker re-check)', async () => {
    await expect(
      runKindToBuffer(VISIBILITY_CAPTURES_KIND, {}, { prisma: fakePrisma(baseDb()), moduleRef: services(false), user }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('planPhotoColumns: current-form order, retired fields appended, duplicate labels made unique', () => {
    const cur = { fields: [{ id: 'b', type: 'CAMERA', label: 'Shelf', order: 2 }, { id: 'a', type: 'CAMERA', label: 'Shelf', order: 1 }] } as any;
    const old = { fields: [{ id: 'z', type: 'CAMERA', label: 'Old photo', order: 1 }, { id: 'a', type: 'CAMERA', label: 'Ignored old label', order: 1 }] } as any;
    expect(planPhotoColumns(cur, [cur, old])).toEqual([
      { fieldId: 'a', label: 'Shelf' }, { fieldId: 'b', label: 'Shelf (2)' }, { fieldId: 'z', label: 'Old photo' },
    ]);
    expect(planPhotoColumns(cur, [])).toEqual([{ fieldId: 'a', label: 'Shelf' }, { fieldId: 'b', label: 'Shelf (2)' }]);
  });
});
