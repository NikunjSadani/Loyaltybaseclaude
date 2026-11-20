/**
 * Metric definitions (VISIBILITY-POSM-DESIGN.md §Metrics) — every number on the report, the admin tile, the
 * Operations funnel and the Daily Ops Digest is defined here.
 *
 * Run: npx jest src/visibility/visibility-metrics.spec.ts
 */
import {
  approvalRatePct,
  countReviewActions,
  foldStatusCounts,
  loadFraudFlags,
  loadMonthStatusCounts,
  monthCaptureWhere,
  monthWindows,
  outsideFenceFields,
  plainStatusOf,
  resolveMonth,
} from './visibility-metrics';
import { outletMasterFencePolicy } from './geo-fence.helper';

const NOW = new Date('2026-11-20T06:30:00Z'); // 20 Nov 2026, 12:00 IST

describe('plain statuses', () => {
  it('maps capture statuses to the plain words; no capture = Not captured yet until the window closes, then Missed', () => {
    expect(plainStatusOf('SUBMITTED', false)).toBe('WAITING');
    expect(plainStatusOf('APPROVED', true)).toBe('APPROVED');
    expect(plainStatusOf('CHANGES_REQUESTED', true)).toBe('NEEDS_RETAKE');
    expect(plainStatusOf('REJECTED', false)).toBe('REJECTED');
    expect(plainStatusOf(null, false)).toBe('NOT_CAPTURED');
    expect(plainStatusOf(null, true)).toBe('MISSED');
    // A waiting capture in a closed window is still Waiting (never Missed).
    expect(plainStatusOf('SUBMITTED', true)).toBe('WAITING');
  });
});

describe('month helpers', () => {
  it('defaults to the current IST month (IST, not UTC, at a month boundary)', () => {
    expect(resolveMonth(undefined, NOW)).toBe('2026-11');
    expect(resolveMonth('', NOW)).toBe('2026-11');
    // 30 Nov 20:00 UTC = 1 Dec 01:30 IST → December.
    expect(resolveMonth(undefined, new Date('2026-11-30T20:00:00Z'))).toBe('2026-12');
    expect(resolveMonth('2025-04', NOW)).toBe('2025-04');
    expect(() => resolveMonth('2026-13', NOW)).toThrow();
  });

  it('windows of a month carry their open/closed state', () => {
    expect(monthWindows('2026-11', 2, NOW)).toEqual([
      { key: '2026-11-P1', closed: true },
      { key: '2026-11-P2', closed: false },
    ]);
    expect(monthWindows('2026-10', 1, NOW)).toEqual([{ key: '2026-10-P1', closed: true }]);
  });

  it('a month selects every window of it by prefix (imported -P1 rows included)', () => {
    expect(monthCaptureWhere('t1', '2025-06')).toEqual({ clientId: 't1', windowKey: { startsWith: '2025-06-P' } });
  });
});

describe('status counts + approval rate', () => {
  it('folds statuses: submitted = every capture; waiting / needs re-take / approved / rejected separate', () => {
    const c = foldStatusCounts('2026-11', [
      { status: 'SUBMITTED', _count: { _all: 4 } },
      { status: 'CHANGES_REQUESTED', _count: { _all: 2 } },
      { status: 'APPROVED', _count: { _all: 6 } },
      { status: 'REJECTED', _count: { _all: 1 } },
    ]);
    expect(c).toEqual({ month: '2026-11', submitted: 13, waiting: 4, needsRetake: 2, approved: 6, rejected: 1 });
  });

  it('approval rate = approved ÷ (approved + needs re-take + rejected); waiting excluded; null when nothing decided', () => {
    expect(approvalRatePct({ approved: 6, needsRetake: 2, rejected: 1 })).toBe(66.7);
    expect(approvalRatePct({ approved: 0, needsRetake: 0, rejected: 0 })).toBeNull();
  });

  it('loadMonthStatusCounts scopes to the month AND the single in-scope outlet rule; empty scope → zeros, no query', async () => {
    const groupBy = jest.fn().mockResolvedValue([{ status: 'SUBMITTED', _count: { _all: 3 } }]);
    const prisma = { visibilityCapture: { groupBy } } as any;
    const cfg = { outletScope: ['SSS'], programs: [], subPrograms: [] };
    const res = await loadMonthStatusCounts(prisma, 't1', cfg, '2026-11');
    expect(res.waiting).toBe(3);
    const where = groupBy.mock.calls[0][0].where;
    expect(where.windowKey).toEqual({ startsWith: '2026-11-P' });
    expect(where.outlet).toMatchObject({ clientId: 't1', isActive: true, outletType: { code: { in: ['SSS'] } } });

    groupBy.mockClear();
    const none = await loadMonthStatusCounts(prisma, 't1', { ...cfg, outletScope: [] }, '2026-11');
    expect(none.submitted).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
  });
});

describe('outside-the-fence photos', () => {
  const schema = {
    captureGpsOnSubmit: false,
    fields: [
      { id: 'w1', type: 'CAMERA', label: 'Window 1', geoFenceRequired: true },
      { id: 'w2', type: 'CAMERA', label: 'Window 2', geoFenceRequired: true },
      { id: 'shelf', type: 'CAMERA', label: 'Shelf', geoFenceRequired: false },
    ],
  } as any;
  const policy = outletMasterFencePolicy({ latitude: 19.0, longitude: 72.8 });
  const near = { lat: 19.0005, lng: 72.8, accuracy: 10 }; // ~55 m
  const far = { lat: 19.05, lng: 72.8, accuracy: 10 }; // ~5.5 km

  it('flags only fence-required photos with a valid fix beyond the radius', () => {
    expect(outsideFenceFields({ w1: { key: 'a', geo: near }, w2: { key: 'b', geo: far }, shelf: { key: 'c', geo: far } }, schema, policy))
      .toEqual(['Window 2']);
  });

  it('unverifiable is NOT outside: no fix, bare-key imported photo, no reference, poor accuracy', () => {
    expect(outsideFenceFields({ w1: 'vendor-import/bajaj/A1/2025-06_w1.jpg' }, schema, policy)).toEqual([]);
    expect(outsideFenceFields({ w1: { key: 'a' } }, schema, policy)).toEqual([]);
    expect(outsideFenceFields({ w1: { key: 'a', geo: far } }, schema, outletMasterFencePolicy({}))).toEqual([]);
    expect(outsideFenceFields({ w1: { key: 'a', geo: { ...far, accuracy: 900 } } }, schema, policy)).toEqual([]);
  });
});

describe('fraud flags (loadFraudFlags)', () => {
  const schema = { captureGpsOnSubmit: false, fields: [{ id: 'w1', type: 'CAMERA', label: 'Window 1', geoFenceRequired: true }] };
  const outlet = { latitude: 19.0, longitude: 72.8, partnerId: null };
  const far = { lat: 19.05, lng: 72.8, accuracy: 10 };
  const near = { lat: 19.0001, lng: 72.8, accuracy: 10 };
  const cap = (id: string, over: Record<string, unknown> = {}) => ({
    id, outletId: `o-${id}`, outletCode: id.toUpperCase(), outletName: id, windowKey: '2026-10-P1', status: 'SUBMITTED',
    formVersion: 1, formValues: { w1: { key: `${id}.jpg`, geo: near } }, geoFenceOk: true, outlet, ...over,
  });

  function prismaWith(captures: any[], hashes: Array<{ captureId: string; hash: string; outletCode?: string; windowKey?: string }>) {
    return {
      visibilityCapture: { findMany: jest.fn().mockResolvedValue(captures) },
      visibilityImageHash: {
        findMany: jest.fn().mockImplementation(({ where, select }: any) => {
          if (where.captureId) return Promise.resolve(hashes.filter((h) => where.captureId.in.includes(h.captureId)));
          expect(select.capture).toBeTruthy();
          return Promise.resolve(
            hashes
              .filter((h) => where.hash.in.includes(h.hash))
              .map((h) => ({ hash: h.hash, captureId: h.captureId, capture: { outletCode: h.outletCode ?? h.captureId.toUpperCase(), windowKey: h.windowKey ?? '2026-10-P1' } })),
          );
        }),
      },
      visibilityFormVersion: { findMany: jest.fn().mockResolvedValue([{ version: 1, formSchema: schema }]) },
      visibilityForm: { findUnique: jest.fn() },
      client: { findUnique: jest.fn().mockResolvedValue({ features: { outletMasterGeo: true } }) },
      kycSubmission: { findMany: jest.fn().mockResolvedValue([]) },
      outlet: { findMany: jest.fn() },
    } as any;
  }
  const cfg = { outletScope: ['SSS'], programs: [], subPrograms: [], geoFence: { radiusMeters: 200 } };

  it('duplicate (hash shared with ANOTHER capture, any month) and outside-fence (stored verdict OR per-photo) — counted once each capture', async () => {
    const captures = [
      cap('a'), // clean
      cap('b'), // duplicate of an OLD capture z (another month)
      cap('c', { formValues: { w1: { key: 'c.jpg', geo: far } } }), // per-photo outside
      cap('d', { geoFenceOk: false }), // stored verdict outside
      cap('e', { formValues: { w1: { key: 'e.jpg', geo: far } } }), // BOTH: outside + duplicate of b? no — of z
      cap('imp', { formValues: { w1: 'vendor-import/x.jpg' }, geoFenceOk: null, status: 'APPROVED' }), // imported: never flagged
    ];
    const hashes = [
      { captureId: 'a', hash: 'h-a' },
      { captureId: 'b', hash: 'h-dup' },
      { captureId: 'z', hash: 'h-dup', outletCode: 'Z9', windowKey: '2026-08-P1' },
      { captureId: 'e', hash: 'h-dup2' },
      { captureId: 'y', hash: 'h-dup2', outletCode: 'Y1', windowKey: '2026-10-P1' },
    ];
    const res = await loadFraudFlags(prismaWith(captures, hashes), 't1', cfg, '2026-10', NOW, 1);
    expect(res.submitted).toBe(6);
    expect(res.flagged).toBe(4); // b, c, d, e
    expect(res.duplicate).toBe(2); // b, e
    expect(res.outsideFence).toBe(3); // c, d, e
    expect(res.flagRatePct).toBe(66.7);
    const byCode = Object.fromEntries(res.rows.map((r) => [r.outletCode, r]));
    expect(byCode.B).toMatchObject({ reasons: ['DUPLICATE_PHOTO'], duplicateOf: [{ outletCode: 'Z9', windowKey: '2026-08-P1' }] });
    expect(byCode.C).toMatchObject({ reasons: ['OUTSIDE_FENCE'], outsidePhotos: ['Window 1'] });
    expect(byCode.D).toMatchObject({ reasons: ['OUTSIDE_FENCE'], outsidePhotos: [] });
    expect(byCode.E.reasons).toEqual(['DUPLICATE_PHOTO', 'OUTSIDE_FENCE']);
    expect(byCode.IMP).toBeUndefined();
    expect(byCode.A).toBeUndefined();
  });

  it('a hash only on the capture itself is not a duplicate', async () => {
    const res = await loadFraudFlags(prismaWith([cap('a')], [{ captureId: 'a', hash: 'h1' }]), 't1', cfg, '2026-10', NOW, 1);
    expect(res.flagged).toBe(0);
    expect(res.flagRatePct).toBe(0);
  });

  it('no captures → rate null (no fabricated 0%)', async () => {
    const res = await loadFraudFlags(prismaWith([], []), 't1', cfg, '2026-10', NOW, 1);
    expect(res).toMatchObject({ submitted: 0, flagged: 0, flagRatePct: null });
  });

  it('non-outlet-master tenant: the reference is the latest APPROVED KYC board photo + configured radius', async () => {
    const p = prismaWith(
      [cap('c', { outlet: { latitude: null, longitude: null, partnerId: 'p1' }, formValues: { w1: { key: 'c.jpg', geo: far } } })],
      [],
    );
    p.client.findUnique.mockResolvedValue({ features: {} });
    p.kycSubmission.findMany.mockResolvedValue([{ partnerId: 'p1', boardPhotoLat: 19.0, boardPhotoLng: 72.8 }]);
    const res = await loadFraudFlags(p, 't1', cfg, '2026-10', NOW, 1);
    expect(res.outsideFence).toBe(1);
    expect(p.kycSubmission.findMany.mock.calls[0][0].where).toMatchObject({ partnerId: { in: ['p1'] }, status: 'APPROVED' });
  });
});

describe('review ACTIONS in a window (digest)', () => {
  const START = Date.parse('2026-11-19T03:30:00Z');
  const END = Date.parse('2026-11-20T03:30:00Z');
  const at = (iso: string) => iso;

  it('a rejection followed by a same-day resubmit still counts (found on the old version snapshot)', () => {
    const res = countReviewActions(
      [
        {
          id: 'c1',
          status: 'SUBMITTED', // resubmitted after the rejection
          reviewedAt: new Date('2026-11-19T06:00:00Z'),
          photoReviews: {}, // the new version has no reviews yet
          submissions: [
            { photoReviews: { w1: { status: 'REJECTED', reasonCode: 'BLURRY', reviewedAt: at('2026-11-19T06:00:00.000Z'), reviewedByUserId: 'g' } } },
            { photoReviews: null },
          ],
        },
      ],
      START,
      END,
    );
    expect(res).toEqual({ actions: 1, approved: 0, rejected: 1, photosApproved: 0, photosRejected: 1 });
  });

  it('approve-all of 2 photos = ONE action; a carried-forward approval is not double counted across versions', () => {
    const rev = { status: 'APPROVED', reviewedAt: '2026-11-19T08:00:00.000Z', reviewedByUserId: 'g' };
    const res = countReviewActions(
      [
        {
          id: 'c2',
          status: 'APPROVED',
          reviewedAt: new Date('2026-11-19T08:00:00Z'),
          photoReviews: { w1: rev, w2: rev },
          submissions: [{ photoReviews: { w1: rev, w2: rev } }],
        },
      ],
      START,
      END,
    );
    expect(res).toEqual({ actions: 1, approved: 1, rejected: 0, photosApproved: 2, photosRejected: 0 });
  });

  it('per-photo decisions at different instants are separate actions; out-of-window decisions ignored', () => {
    const res = countReviewActions(
      [
        {
          id: 'c3',
          status: 'CHANGES_REQUESTED',
          reviewedAt: new Date('2026-11-19T10:00:00Z'),
          photoReviews: {
            w1: { status: 'APPROVED', reviewedAt: '2026-11-19T09:00:00.000Z', reviewedByUserId: 'g' },
            w2: { status: 'REJECTED', reasonCode: 'X', reviewedAt: '2026-11-19T10:00:00.000Z', reviewedByUserId: 'g' },
            w3: { status: 'APPROVED', reviewedAt: '2026-11-18T10:00:00.000Z', reviewedByUserId: 'g' }, // before window
          },
        },
      ],
      START,
      END,
    );
    expect(res).toEqual({ actions: 2, approved: 1, rejected: 1, photosApproved: 1, photosRejected: 1 });
  });

  it('legacy capture with no photo reviews: falls back to the whole-capture reviewedAt + status', () => {
    const res = countReviewActions(
      [
        { id: 'l1', status: 'APPROVED', reviewedAt: new Date('2026-11-19T12:00:00Z'), photoReviews: null },
        { id: 'l2', status: 'REJECTED', reviewedAt: new Date('2026-11-19T12:00:00Z'), photoReviews: null },
        { id: 'l3', status: 'SUBMITTED', reviewedAt: null, photoReviews: null },
        { id: 'l4', status: 'APPROVED', reviewedAt: new Date('2026-11-01T12:00:00Z'), photoReviews: null }, // outside
      ],
      START,
      END,
    );
    expect(res).toMatchObject({ actions: 2, approved: 1, rejected: 1 });
  });
});
