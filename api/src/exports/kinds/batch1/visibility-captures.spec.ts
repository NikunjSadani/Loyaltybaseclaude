/**
 * Visibility captures export kind (`visibility-captures`) — PARITY with the old in-memory builder
 * (VisibilityReportService.exportCaptures, copied below as `oldExportCaptures`), tenant isolation, paging across
 * 2,000-row pages, the per-page duplicate-photo check, cellSafe, the heavy rule and the master-switch 403.
 */
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { buildXlsx } from '../../../common/xlsx';
import { istDateTimeCell } from '../../../common/ist-date';
import { TenantService } from '../../../tenant/tenant.service';
import { TenantSettingsService } from '../../../tenant/tenant-settings.service';
import { readMediaValue } from '../../../visibility/visibility-form.helper';
import { evaluatePhotoFence, haversineMeters } from '../../../visibility/geo-fence.helper';
import { VISIBILITY_CAPTURES_KIND } from './visibility-captures';
import { expectSameWorkbook, fakeModuleRef, readBack, runKindToBuffer, seeded } from './parity-testkit-spec';

interface CaptureRec {
  id: string;
  clientId: string;
  outletId: string;
  outletCode: string;
  outletName: string;
  windowKey: string;
  status: string;
  geoFenceOk: boolean | null;
  distanceMeters: number | null;
  captureAccuracy: number | null;
  capturedAt: Date | null;
  receivedAt: Date;
  rejectionReasonCode: string | null;
  rejectionReason: string | null;
  formValues: Prisma.JsonValue;
  formVersion: number;
  submittedBy: { employeeCode: string } | null;
}
interface Db {
  captures: CaptureRec[];
  hashes: { clientId: string; captureId: string; hash: string }[];
  versions: { clientId: string; version: number; formSchema: unknown }[];
  outlets: { id: string; clientId: string; partnerId: string | null; latitude?: number | null; longitude?: number | null }[];
  partners: { id: string; clientId: string; geo: { lat: Prisma.Decimal; lng: Prisma.Decimal } | null }[];
  /** clients.features (absent = no flags — every parity fixture). */
  features?: Record<string, unknown>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function fakePrisma(db: Db) {
  const calls: Record<string, unknown[]> = {};
  const log = (k: string, a: unknown) => (calls[k] ??= []).push(a);
  const matchKeyset = (c: CaptureRec, or: Array<Record<string, any>>) =>
    (c.windowKey > or[0].windowKey.gt) ||
    (c.windowKey === or[1].windowKey && c.outletCode > or[1].outletCode.gt) ||
    (c.windowKey === or[2].windowKey && c.outletCode === or[2].outletCode && c.id > or[2].id.gt);
  return {
    calls,
    client: {
      findUnique: async (a: unknown) => {
        log('client.findUnique', a);
        return db.features ? { features: db.features } : null;
      },
    },
    visibilityCapture: {
      findMany: async (a: { where: Record<string, any>; take?: number }) => {
        log('visibilityCapture.findMany', a);
        const base = a.where.AND ? a.where.AND[0] : a.where;
        const keyset = a.where.AND ? a.where.AND[1].OR : null;
        let rows = db.captures.filter(
          (c) => c.clientId === base.clientId && (base.windowKey === undefined || c.windowKey === base.windowKey) && (!keyset || matchKeyset(c, keyset)),
        );
        rows = [...rows].sort((x, y) => cmp(x.windowKey, y.windowKey) || cmp(x.outletCode, y.outletCode) || cmp(x.id, y.id));
        if (a.take) rows = rows.slice(0, a.take);
        return rows.map(({ clientId: _c, ...r }) => r);
      },
    },
    visibilityImageHash: {
      findMany: async (a: { where: { clientId: string; captureId?: { in: string[] }; hash?: { in: string[] } } }) => {
        log('visibilityImageHash.findMany', a);
        return db.hashes
          .filter((h) => h.clientId === a.where.clientId)
          .filter((h) => !a.where.captureId || a.where.captureId.in.includes(h.captureId))
          .filter((h) => !a.where.hash || a.where.hash.in.includes(h.hash))
          .map((h) => ({ hash: h.hash, captureId: h.captureId }));
      },
    },
    visibilityFormVersion: {
      findMany: async (a: { where: { clientId: string; version: { in: number[] } } }) => {
        log('visibilityFormVersion.findMany', a);
        return db.versions.filter((v) => v.clientId === a.where.clientId && a.where.version.in.includes(v.version));
      },
    },
    outlet: {
      findMany: async (a: { where: { id: { in: string[] }; clientId: string } }) => {
        log('outlet.findMany', a);
        return db.outlets
          .filter((o) => a.where.id.in.includes(o.id) && o.clientId === a.where.clientId)
          .map(({ id, partnerId, latitude, longitude }) => ({ id, partnerId, latitude: latitude ?? null, longitude: longitude ?? null }));
      },
    },
    channelPartner: {
      findMany: async (a: { where: { id: { in: string[] }; clientId: string } }) => {
        log('channelPartner.findMany', a);
        return db.partners
          .filter((p) => a.where.id.in.includes(p.id) && p.clientId === a.where.clientId)
          .map((p) => ({ id: p.id, kycSubmissions: p.geo ? [{ boardPhotoLat: p.geo.lat, boardPhotoLng: p.geo.lng }] : [] }));
      },
    },
  };
}

// ─── The OLD builder, verbatim (VisibilityReportService.exportCaptures before 2026-11-13) ───────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
async function oldExportCaptures(prisma: any, clientId: string, radiusMeters: number, windowKey?: string): Promise<Buffer> {
  const where: Record<string, unknown> = { clientId };
  if (windowKey && windowKey.trim()) where.windowKey = windowKey;
  const captures: any[] = await prisma.visibilityCapture.findMany({ where, orderBy: [{ windowKey: 'asc' }, { outletCode: 'asc' }] });
  // dup flag (old: every hash row of the tenant)
  const dup = new Set<string>();
  if (captures.length) {
    const hashes: any[] = await prisma.visibilityImageHash.findMany({ where: { clientId } });
    const byHash = new Map<string, Set<string>>();
    for (const h of hashes) byHash.set(h.hash, (byHash.get(h.hash) ?? new Set<string>()).add(h.captureId));
    const inSet = new Set(captures.map((c) => c.id));
    for (const ids of byHash.values()) if (ids.size > 1) for (const id of ids) if (inSet.has(id)) dup.add(id);
  }
  const versions = [...new Set(captures.map((c) => c.formVersion))];
  const snaps: any[] = versions.length ? await prisma.visibilityFormVersion.findMany({ where: { clientId, version: { in: versions } } }) : [];
  const schemaByVersion = new Map<number, any>();
  for (const s of snaps) schemaByVersion.set(s.version, s.formSchema);
  // reference geo
  const ref = new Map<string, { lat: number; lng: number }>();
  const ids = [...new Set(captures.map((c) => c.outletId).filter(Boolean))];
  if (ids.length) {
    const outlets: any[] = await prisma.outlet.findMany({ where: { id: { in: ids }, clientId } });
    const pids = [...new Set(outlets.map((o) => o.partnerId).filter(Boolean))];
    if (pids.length) {
      const partners: any[] = await prisma.channelPartner.findMany({ where: { id: { in: pids }, clientId } });
      const g = new Map<string, { lat: number; lng: number }>();
      for (const p of partners) {
        const sub = p.kycSubmissions?.[0];
        if (sub && sub.boardPhotoLat != null && sub.boardPhotoLng != null) g.set(p.id, { lat: Number(sub.boardPhotoLat), lng: Number(sub.boardPhotoLng) });
      }
      for (const o of outlets) {
        const x = o.partnerId ? g.get(o.partnerId) : undefined;
        if (x) ref.set(o.id, x);
      }
    }
  }
  const photosOf = (formValues: any, schema: any, reference: any) => {
    if (!formValues || typeof formValues !== 'object') return [];
    if (!schema?.fields) return [];
    const out: any[] = [];
    for (const f of schema.fields) {
      if (f.type !== 'CAMERA') continue;
      const { key, geo } = readMediaValue(formValues[f.id]);
      if (!key) continue;
      const link = `/v1/visibility/captures/media?key=${encodeURIComponent(key)}`;
      if (geo) {
        const acc = geo.accuracy != null ? ` (±${Math.round(geo.accuracy)}m)` : '';
        const status = evaluatePhotoFence(geo, reference, radiusMeters);
        const distance = reference != null ? String(Math.round(haversineMeters(geo, reference) * 100) / 100) : '';
        out.push({ link, geo: `${geo.lat}, ${geo.lng}${acc}`, distance, status });
      } else out.push({ link, geo: '', distance: '', status: '' });
    }
    return out;
  };
  const rows = captures.map((c) => {
    const photos = photosOf(c.formValues, schemaByVersion.get(c.formVersion), ref.get(c.outletId) ?? null);
    return {
      'Outlet Code': c.outletCode,
      'Outlet Name': c.outletName,
      Window: c.windowKey,
      Status: c.status,
      Rep: c.submittedBy?.employeeCode ?? '',
      'Geo-fence OK': c.geoFenceOk === null ? 'UNVERIFIABLE' : c.geoFenceOk ? 'YES' : 'NO',
      'Distance (m)': c.distanceMeters != null ? String(c.distanceMeters) : '',
      'Captured At': c.capturedAt ? istDateTimeCell(c.capturedAt) : '',
      'Received At': istDateTimeCell(c.receivedAt),
      'Accuracy (m)': c.captureAccuracy != null ? String(c.captureAccuracy) : '',
      'Duplicate Photo': dup.has(c.id) ? 'YES' : '',
      'Reject Reason': c.rejectionReasonCode ?? '',
      'Reject Detail': c.rejectionReason ?? '',
      Photos: photos.map((p: any) => p.link).join(' | '),
      'Photo Geo': photos.map((p: any) => p.geo).join(' | '),
      'Photo Distance (m)': photos.map((p: any) => p.distance).join(' | '),
      'Photo Status': photos.map((p: any) => p.status).join(' | '),
    };
  });
  const empty = Object.fromEntries(
    ['Outlet Code', 'Outlet Name', 'Window', 'Status', 'Rep', 'Geo-fence OK', 'Distance (m)', 'Captured At', 'Received At',
      'Accuracy (m)', 'Duplicate Photo', 'Reject Reason', 'Reject Detail', 'Photos', 'Photo Geo', 'Photo Distance (m)', 'Photo Status'].map((h) => [h, '']),
  );
  return buildXlsx([{ name: 'Captures', rows: rows.length ? rows : [empty] }]);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────

const RADIUS = 50;

function bigDb(clientId: string, n: number): Db {
  const rnd = seeded(3);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const db: Db = { captures: [], hashes: [], versions: [], outlets: [], partners: [] };
  db.versions.push({ clientId, version: 1, formSchema: { fields: [{ id: 'photo', type: 'CAMERA' }, { id: 'note', type: 'TEXT' }] } });
  db.versions.push({ clientId, version: 2, formSchema: { fields: [{ id: 'p1', type: 'CAMERA' }, { id: 'p2', type: 'CAMERA' }] } });
  db.versions.push({ clientId: 'other', version: 3, formSchema: { fields: [{ id: 'x', type: 'CAMERA' }] } });
  for (let o = 0; o < 400; o++) {
    const partnerId = rnd() < 0.8 ? `p${o}` : null;
    db.outlets.push({ id: `o${o}`, clientId, partnerId });
    if (partnerId) db.partners.push({ id: partnerId, clientId, geo: rnd() < 0.7 ? { lat: new Prisma.Decimal('19.0760'), lng: new Prisma.Decimal('72.8777') } : null });
  }
  const windows = ['2026-08-P1', '2026-09-P1', '2026-09-P2', '2026-10-P1'];
  for (let i = 0; i < n; i++) {
    const o = Math.floor(rnd() * 400);
    const v = pick([1, 2, 3, 9]); // 3 = another tenant's version, 9 = missing snapshot
    const geoPhoto = () => (rnd() < 0.5 ? `visibility-media/${clientId}/${i}.jpg` : { key: `visibility-media/${clientId}/${i}-g.jpg`, geo: { lat: 19.07 + rnd() / 100, lng: 72.87 + rnd() / 100, accuracy: rnd() < 0.5 ? 12.4 : null } });
    const id = `cap${String(i).padStart(6, '0')}`;
    db.captures.push({
      id, clientId, outletId: `o${o}`, outletCode: i % 101 === 0 ? 'SAME' : `OC${String(o).padStart(4, '0')}`,
      outletName: i === 3 ? '=cmd()' : `Shop ${o}`, windowKey: pick(windows),
      status: pick(['APPROVED', 'SUBMITTED', 'REJECTED', 'CHANGES_REQUESTED']),
      geoFenceOk: pick([true, false, null]), distanceMeters: rnd() < 0.7 ? Math.round(rnd() * 200) : null,
      captureAccuracy: rnd() < 0.7 ? Math.round(rnd() * 30) : null,
      capturedAt: rnd() < 0.9 ? new Date(Date.parse('2026-09-01T00:00:00Z') + i * 60_000) : null,
      receivedAt: new Date(Date.parse('2026-09-01T00:05:00Z') + i * 60_000),
      rejectionReasonCode: pick([null, 'BLURRY', '-X']), rejectionReason: pick([null, 'photo blurry', '@detail']),
      formValues: v === 1 ? { photo: geoPhoto(), note: 'n' } : v === 2 ? { p1: geoPhoto(), p2: geoPhoto() } : rnd() < 0.5 ? { x: 'k' } : null,
      formVersion: v, submittedBy: rnd() < 0.9 ? { employeeCode: `E${o % 30}` } : null,
    });
    // ~5% share a photo hash with another capture (some across windows), the rest unique.
    db.hashes.push({ clientId, captureId: id, hash: rnd() < 0.05 ? `H${Math.floor(rnd() * 40)}` : `U${i}` });
  }
  // Another tenant: same hash values must not make OUR captures duplicates; its captures never appear.
  for (let i = 0; i < 30; i++) {
    db.captures.push({ ...db.captures[i], id: `other${i}`, clientId: 'other', outletName: `OTHER-TENANT-${i}` });
    db.hashes.push({ clientId: 'other', captureId: `other${i}`, hash: `U${i}` });
  }
  return db;
}

const user: JwtPayload = { sub: 'a', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: '' };
const services = (enabled = true) =>
  fakeModuleRef([
    [TenantService, { resolveVisibilityEnabled: async () => enabled }],
    [TenantSettingsService, { getEffectiveSettings: async () => ({ visibilityConfig: { geoFence: { radiusMeters: RADIUS } } }) }],
  ]);

async function both(db: Db, windowKey?: string) {
  const old = await oldExportCaptures(fakePrisma(db), 'bajaj', RADIUS, windowKey);
  const prisma = fakePrisma(db);
  const t = performance.now();
  const res = await runKindToBuffer(VISIBILITY_CAPTURES_KIND, windowKey === undefined ? {} : { windowKey }, { prisma, moduleRef: services(), user });
  return { old, ...res, prisma, ms: Math.round(performance.now() - t) };
}

// Thousands of rows through two full xlsx builds per test: allow for a loaded CI box.
jest.setTimeout(120_000);

describe('visibility-captures export kind', () => {
  it('PARITY (all windows, 4,300 captures = 3 pages): sheet, headers, every cell equal the old builder', async () => {
    const db = bigDb('bajaj', 4300);
    const { old, buffer, rowCount, prisma, ms, heavy, fileName } = await both(db);
    const got = expectSameWorkbook(buffer, old);
    expect(rowCount).toBe(4300);
    expect(got.rows.Captures).toHaveLength(4301);
    expect(JSON.stringify(got.rows)).not.toContain('OTHER-TENANT');
    expect(got.rows.Captures.some((r) => r[10] === 'YES')).toBe(true); // some duplicates flagged
    const pages = prisma.calls['visibilityCapture.findMany'] as Array<{ take: number }>;
    expect(pages).toHaveLength(3);
    // Duplicate check reads only the page's hashes (+ the captures sharing them), never the whole tenant's table.
    for (const c of prisma.calls['visibilityImageHash.findMany'] as Array<{ where: Record<string, unknown> }>) {
      expect(Object.keys(c.where).sort()).toEqual(expect.arrayContaining(['clientId']));
      expect(c.where.captureId ?? c.where.hash).toBeDefined();
    }
    // Form versions are read once each across pages.
    const versionsRead = (prisma.calls['visibilityFormVersion.findMany'] as Array<{ where: { version: { in: number[] } } }>)
      .flatMap((c) => c.where.version.in);
    expect(new Set(versionsRead).size).toBe(versionsRead.length);
    expect(heavy).toBe(true);
    expect(fileName).toBe('visibility_captures_all_2026-11-13.xlsx');
    // eslint-disable-next-line no-console
    console.log(`visibility-captures parity: 4300 rows in ${ms} ms (fake DB)`);
  });

  it('PARITY (one window): light, file name carries the window', async () => {
    const db = bigDb('bajaj', 2500);
    const { old, buffer, heavy, fileName } = await both(db, '2026-09-P1');
    expectSameWorkbook(buffer, old);
    expect(heavy).toBe(false);
    expect(fileName).toBe('visibility_captures_2026-09-P1_2026-11-13.xlsx');
  });

  it('PARITY (no captures): every header + one all-blank row', async () => {
    const { old, buffer } = await both({ captures: [], hashes: [], versions: [], outlets: [], partners: [] });
    const got = expectSameWorkbook(buffer, old);
    expect(got.rows.Captures).toHaveLength(2);
  });

  it('cellSafe on user text', async () => {
    const { buffer } = await both(bigDb('bajaj', 10));
    const rows = readBack(buffer).rows.Captures;
    expect(rows.some((r) => r[1] === "'=cmd()")).toBe(true);
  });

  // ── Outlet-master tenants: the capture verdict's own per-photo policy (prod finding 2026-11-19) ──
  it('outlet-master tenant: Photo Status / Distance use the outlet master + 200 m + buffer; 0,0 unverifiable; non-fence photos no status', async () => {
    const at = (lat: number, lng: number, accuracy: number) => ({ lat, lng, accuracy });
    const db: Db = {
      features: { outletMasterGeo: true },
      outlets: [{ id: 'o1', clientId: 'bajaj', partnerId: 'p1', latitude: 12.9, longitude: 77.5 }],
      // A far KYC board geo that must NOT be used on an outlet-master tenant.
      partners: [{ id: 'p1', clientId: 'bajaj', geo: { lat: new Prisma.Decimal('13.5'), lng: new Prisma.Decimal('78.5') } }],
      versions: [{
        clientId: 'bajaj', version: 1,
        formSchema: { fields: [
          { id: 'w1', type: 'CAMERA', geoFenceRequired: true },
          { id: 'w2', type: 'CAMERA', geoFenceRequired: true },
          { id: 'plain', type: 'CAMERA' },
        ] },
      }],
      hashes: [],
      captures: [
        { id: 'c1', clientId: 'bajaj', outletId: 'o1', outletCode: 'A', outletName: 'Elite', windowKey: '2026-11-P1', status: 'SUBMITTED',
          geoFenceOk: true, distanceMeters: 34, captureAccuracy: 20, capturedAt: null, receivedAt: new Date('2026-11-19T05:00:00Z'),
          rejectionReasonCode: null, rejectionReason: null, formVersion: 1, submittedBy: null,
          formValues: { w1: { key: 'k/w1.jpg', geo: at(12.9003, 77.5001, 20) }, plain: { key: 'k/p.jpg', geo: at(12.9003, 77.5001, 5) } } },
        { id: 'c2', clientId: 'bajaj', outletId: 'o1', outletCode: 'B', outletName: 'Edge', windowKey: '2026-11-P1', status: 'SUBMITTED',
          geoFenceOk: null, distanceMeters: null, captureAccuracy: null, capturedAt: null, receivedAt: new Date('2026-11-19T05:00:00Z'),
          rejectionReasonCode: null, rejectionReason: null, formVersion: 1, submittedBy: null,
          formValues: { w1: { key: 'k/w1b.jpg', geo: at(12.9003, 77.5001, 350) }, w2: { key: 'k/w2b.jpg', geo: at(0, 0, 5) } } },
      ],
    };
    const { buffer } = await runKindToBuffer(VISIBILITY_CAPTURES_KIND, {}, { prisma: fakePrisma(db), moduleRef: services(), user });
    const rows = readBack(buffer).rows.Captures;
    const header = rows[0] as string[];
    const col = (name: string) => header.indexOf(name);
    const r1 = rows[1] as string[];
    const r2 = rows[2] as string[];
    expect(r1[col('Photo Status')]).toBe('inside | ');
    expect(Number(String(r1[col('Photo Distance (m)')]).split(' | ')[0])).toBeLessThan(40);
    expect(r2[col('Photo Status')]).toBe('unverifiable | unverifiable'); // ±350 m buffer; 0,0 never "outside"
    expect(String(r2[col('Photo Distance (m)')]).split(' | ')[1]).toBe('');
  });

  it('non-gated tenant: the per-photo columns are unchanged (KYC board reference + configured radius)', async () => {
    const db = bigDb('bajaj', 50);
    const { old, buffer } = await both(db);
    expectSameWorkbook(buffer, old);
  });

  it('403 when the tenant\'s Visibility switch is off (worker re-check)', async () => {
    await expect(
      runKindToBuffer(VISIBILITY_CAPTURES_KIND, {}, { prisma: fakePrisma(bigDb('bajaj', 1)), moduleRef: services(false), user }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('parseParams mirrors the old optional windowKey (blank = all) and rejects a non-string', () => {
    expect(VISIBILITY_CAPTURES_KIND.parseParams({}, user)).toEqual({});
    expect(VISIBILITY_CAPTURES_KIND.parseParams({ windowKey: '  ' }, user)).toEqual({});
    expect(VISIBILITY_CAPTURES_KIND.parseParams({ windowKey: '2026-09-P1', requestOrigin: 'x' }, user)).toEqual({ windowKey: '2026-09-P1' });
    expect(() => VISIBILITY_CAPTURES_KIND.parseParams({ windowKey: ['a'] }, user)).toThrow('windowKey must be a string');
    expect(VISIBILITY_CAPTURES_KIND.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'visibility:read' });
  });
});
