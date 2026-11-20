/**
 * Metric definitions (VISIBILITY-POSM-DESIGN.md §17) — every number on the report, the admin tile, the
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
  PLAIN_STATUS_LABEL,
  DUPLICATE_LIST_CAP,
  resolveMonth,
} from './visibility-metrics';
import {
  classifyWindowAgainstGoLive,
  isImportedMonthRule,
  isImportedVisibilityCapture,
  isVisibilityImportedMonth,
  clearVisibilityGoLiveCache,
  noteVisibilityPortalCapture,
  goLiveMonthOf,
  visibilityPortalGoLive,
} from './visibility-portal-go-live';
import { outletMasterFencePolicy } from './geo-fence.helper';
import { VISIBILITY_WORDS, visibilityStatusWords } from './visibility-report-labels';

const NOW = new Date('2026-11-20T06:30:00Z'); // 20 Nov 2026, 12:00 IST

describe('plain statuses', () => {
  it('maps capture statuses to the plain words; no capture = Not captured yet until the window closes, then Missed', () => {
    expect(plainStatusOf('SUBMITTED', false)).toBe('WAITING');
    expect(plainStatusOf('APPROVED', true)).toBe('APPROVED');
    expect(plainStatusOf('CHANGES_REQUESTED', false)).toBe('NEEDS_RETAKE');
    expect(plainStatusOf('REJECTED', false)).toBe('REJECTED');
    expect(plainStatusOf(null, false)).toBe('NOT_CAPTURED');
    expect(plainStatusOf(null, true)).toBe('MISSED');
    // A waiting capture in a closed window is still Waiting (never Missed).
    expect(plainStatusOf('SUBMITTED', true)).toBe('WAITING');
  });

  it('THE word list (pinned — the platform mirror lib/visibility-types.ts VISIBILITY_STATUS_WORDS pins the same strings)', () => {
    expect(PLAIN_STATUS_LABEL).toEqual({
      WAITING: 'Waiting for review',
      APPROVED: 'Approved',
      NEEDS_RETAKE: 'Needs re-take',
      REJECTED: 'Rejected',
      CLOSED_NOT_APPROVED: 'Not approved — window closed',
      NOT_CAPTURED: 'Not captured yet',
      MISSED: 'Missed',
      NOT_TRACKED: 'Not tracked for imported months',
      PART_OLD_APP: 'No approved record — part of this window was on the old app',
    });
    expect(VISIBILITY_WORDS.NOT_STARTED).toBe('Not started');
    expect(visibilityStatusWords('CHANGES_REQUESTED', { windowClosed: true })).toBe('Not approved — window closed');
    expect(visibilityStatusWords('REJECTED', { windowClosed: true })).toBe('Not approved — window closed');
    expect(visibilityStatusWords('APPROVED', { windowClosed: true })).toBe('Approved');
    expect(visibilityStatusWords('CHANGES_REQUESTED')).toBe('Needs re-take');
  });

  it('closed window partly on the old app with no capture → PART_OLD_APP (never Missed); a capture keeps its status', () => {
    expect(plainStatusOf(null, true, false, true)).toBe('PART_OLD_APP');
    expect(plainStatusOf(null, false, false, true)).toBe('NOT_CAPTURED');
    expect(plainStatusOf('APPROVED', true, false, true)).toBe('APPROVED');
  });

  it('a re-take / rejection left when the window CLOSED is final: Not approved — window closed (never waiting on reps)', () => {
    expect(plainStatusOf('CHANGES_REQUESTED', true)).toBe('CLOSED_NOT_APPROVED');
    expect(plainStatusOf('REJECTED', true)).toBe('CLOSED_NOT_APPROVED');
    expect(PLAIN_STATUS_LABEL.CLOSED_NOT_APPROVED).toBe('Not approved — window closed');
  });

  it('imported month: no capture = Not tracked (never Missed, whatever the window); a capture keeps its status', () => {
    expect(plainStatusOf(null, true, true)).toBe('NOT_TRACKED');
    expect(plainStatusOf(null, false, true)).toBe('NOT_TRACKED');
    expect(plainStatusOf('APPROVED', true, true)).toBe('APPROVED');
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
  it('folds statuses: submitted = every capture; a closed window moves re-take / rejected to "not approved — window closed"', () => {
    const closed = (wk: string) => wk === '2026-11-P1';
    const c = foldStatusCounts(
      '2026-11',
      [
        { status: 'SUBMITTED', windowKey: '2026-11-P2', _count: { _all: 4 } },
        { status: 'CHANGES_REQUESTED', windowKey: '2026-11-P2', _count: { _all: 2 } },
        { status: 'CHANGES_REQUESTED', windowKey: '2026-11-P1', _count: { _all: 3 } },
        { status: 'APPROVED', windowKey: '2026-11-P1', _count: { _all: 6 } },
        { status: 'REJECTED', windowKey: '2026-11-P2', _count: { _all: 1 } },
        { status: 'REJECTED', windowKey: '2026-11-P1', _count: { _all: 2 } },
      ],
      closed,
    );
    expect(c).toEqual({
      month: '2026-11', submitted: 18, waiting: 4, needsRetake: 2, approved: 6, rejected: 1, closedNotApproved: 5,
      waitingOnReps: 3, waitingAllMonths: 4, waitingEarlierMonths: 0,
    });
  });

  it("waiting for review counts EVERY month (Gifsy's whole queue), with the earlier-months share", () => {
    const c = foldStatusCounts('2026-10', [{ status: 'SUBMITTED', windowKey: '2026-10-P1', _count: { _all: 2 } }], () => true, [
      { windowKey: '2026-08-P1', _count: { _all: 5 } },
      { windowKey: '2026-09-P2', _count: { _all: 1 } },
      { windowKey: '2026-10-P1', _count: { _all: 2 } },
    ]);
    expect(c).toMatchObject({ waiting: 2, waitingAllMonths: 8, waitingEarlierMonths: 6 });
  });

  it('approval rate = approved ÷ every decided capture (incl. not approved — window closed); null when nothing decided', () => {
    expect(approvalRatePct({ approved: 6, needsRetake: 2, rejected: 1 })).toBe(66.7);
    expect(approvalRatePct({ approved: 6, needsRetake: 0, rejected: 0, closedNotApproved: 2 })).toBe(75);
    expect(approvalRatePct({ approved: 0, needsRetake: 0, rejected: 0 })).toBeNull();
  });

  it('loadMonthStatusCounts: month + single in-scope rule; the waiting queue is NOT month-limited; empty scope → zeros, no query', async () => {
    const groupBy = jest
      .fn()
      .mockResolvedValueOnce([
        { status: 'SUBMITTED', windowKey: '2026-11-P1', _count: { _all: 3 } },
        { status: 'CHANGES_REQUESTED', windowKey: '2026-11-P1', _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([
        { windowKey: '2026-09-P1', _count: { _all: 4 } },
        { windowKey: '2026-11-P1', _count: { _all: 3 } },
      ]);
    const prisma = { visibilityCapture: { groupBy } } as any;
    const cfg = { outletScope: ['SSS'], programs: [], subPrograms: [] };
    // Frequency 2 on 20 Nov: P1 (1–15) has closed → the 2 re-takes there are final.
    const res = await loadMonthStatusCounts(prisma, 't1', cfg, '2026-11', { now: NOW, freq: 2 });
    expect(res).toMatchObject({
      waiting: 3, waitingAllMonths: 7, waitingEarlierMonths: 4, needsRetake: 0, closedNotApproved: 2, waitingOnReps: 0,
    });
    const where = groupBy.mock.calls[0][0].where;
    expect(where.windowKey).toEqual({ startsWith: '2026-11-P' });
    expect(where.outlet).toMatchObject({ clientId: 't1', isActive: true, outletType: { code: { in: ['SSS'] } } });
    const qWhere = groupBy.mock.calls[1][0].where;
    expect(qWhere).toMatchObject({ clientId: 't1', status: 'SUBMITTED' });
    expect(qWhere.windowKey).toBeUndefined();
    expect(qWhere.outlet).toMatchObject({ isActive: true });

    groupBy.mockClear();
    const none = await loadMonthStatusCounts(prisma, 't1', { ...cfg, outletScope: [] }, '2026-11', { now: NOW, freq: 1 });
    expect(none.submitted).toBe(0);
    expect(none.waitingAllMonths).toBe(0);
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

  it('one photo shared by many captures: lists at most DUPLICATE_LIST_CAP others but keeps the full count', async () => {
    const n = 40;
    const captures = Array.from({ length: n }, (_, i) => cap(`c${i}`));
    const hashes = captures.map((c) => ({ captureId: c.id, hash: 'same' }));
    const res = await loadFraudFlags(prismaWith(captures, hashes), 't1', cfg, '2026-10', NOW, 1);
    expect(res.duplicate).toBe(n);
    for (const r of res.rows) {
      expect(r.duplicateOf.length).toBe(DUPLICATE_LIST_CAP);
      expect(r.duplicateCount).toBe(n - 1);
    }
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

  it('per-photo decisions the same day = ONE review (its final outcome); out-of-window decisions ignored', () => {
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
    expect(res).toEqual({ actions: 1, approved: 0, rejected: 1, photosApproved: 1, photosRejected: 1 });
  });

  it('rejected then re-approved the same day = ONE approved review (final outcome); decisions on two IST days = two', () => {
    const res = countReviewActions(
      [
        {
          id: 'c4',
          status: 'APPROVED',
          reviewedAt: new Date('2026-11-19T12:00:00Z'),
          photoReviews: { w1: { status: 'APPROVED', reviewedAt: '2026-11-19T12:00:00.000Z', reviewedByUserId: 'g' } },
          submissions: [{ photoReviews: { w1: { status: 'REJECTED', reasonCode: 'X', reviewedAt: '2026-11-19T06:00:00.000Z', reviewedByUserId: 'g' } } }],
        },
      ],
      START,
      END,
    );
    expect(res).toEqual({ actions: 1, approved: 1, rejected: 0, photosApproved: 1, photosRejected: 0 });

    // 18 Nov 22:00 UTC = 19 Nov 03:30 IST; 19 Nov 20:00 UTC = 20 Nov 01:30 IST → two IST days.
    const two = countReviewActions(
      [
        {
          id: 'c5',
          status: 'APPROVED',
          reviewedAt: new Date('2026-11-19T20:00:00Z'),
          photoReviews: { w1: { status: 'APPROVED', reviewedAt: '2026-11-19T20:00:00.000Z', reviewedByUserId: 'g' } },
          submissions: [{ photoReviews: { w1: { status: 'REJECTED', reasonCode: 'X', reviewedAt: '2026-11-18T22:00:00.000Z', reviewedByUserId: 'g' } } }],
        },
      ],
      Date.parse('2026-11-18T18:30:00Z'),
      Date.parse('2026-11-20T18:30:00Z'),
    );
    expect(two).toMatchObject({ actions: 2, approved: 1, rejected: 1 });
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

describe('imported (old-app) history — visibility-portal-go-live (the one module)', () => {
  it('an imported capture = a photo stored under /vendor-import/ (not "no submitting rep")', () => {
    expect(isImportedVisibilityCapture({ w1: 'visibility-media/bajaj/not-vendor-import-ish.jpg' })).toBe(false);
    expect(isImportedVisibilityCapture({ w1: 'visibility-media/bajaj/vendor-import/a.jpg' })).toBe(true);
    expect(isImportedVisibilityCapture({ w1: { key: 'visibility-media/bajaj/vendor-import/a.jpg' } })).toBe(true);
    expect(isImportedVisibilityCapture({ w1: { key: 'visibility-media/bajaj/2026-11/a.jpg' }, note: 'hi' })).toBe(false);
    expect(isImportedVisibilityCapture(null)).toBe(false);
  });

  it('imported month = before the portal go-live month; no go-live → a month holding captures', () => {
    expect(isImportedMonthRule('2026-08', '2026-10', false)).toBe(true);
    expect(isImportedMonthRule('2026-10', '2026-10', true)).toBe(false);
    expect(isImportedMonthRule('2026-11', '2026-10', true)).toBe(false);
    expect(isImportedMonthRule('2025-06', null, true)).toBe(true);
    expect(isImportedMonthRule('2026-11', null, false)).toBe(false);
  });

  it('go-live month = the IST month of the go-live INSTANT; the loader counts only when there is no go-live', async () => {
    // 2026-09-30 19:00 UTC = 1 Oct 00:30 IST → go-live month 2026-10 (IST, not UTC).
    const $queryRaw = jest.fn().mockResolvedValue([{ goLive: new Date('2026-09-30T19:00:00Z') }]);
    const count = jest.fn();
    const prisma = { $queryRaw, visibilityCapture: { count } } as any;
    clearVisibilityGoLiveCache();
    expect(goLiveMonthOf(await visibilityPortalGoLive(prisma, 't1'))).toBe('2026-10');
    expect(await isVisibilityImportedMonth(prisma, 't1', '2026-09')).toBe(true);
    expect(await isVisibilityImportedMonth(prisma, 't1', '2026-10')).toBe(false);
    expect(count).not.toHaveBeenCalled();

    $queryRaw.mockResolvedValue([{ goLive: null }]);
    clearVisibilityGoLiveCache('t1');
    count.mockResolvedValueOnce(12).mockResolvedValueOnce(0);
    expect(await isVisibilityImportedMonth(prisma, 't1', '2025-06')).toBe(true);
    expect(await isVisibilityImportedMonth(prisma, 't1', '2026-11')).toBe(false);
    expect(count.mock.calls[0][0]).toEqual({ where: { clientId: 't1', windowKey: { startsWith: '2025-06-P' } } });
  });

  it('go-live is cached per tenant for 5 minutes (one aggregate per load, not per window / outlet); clear drops it', async () => {
    clearVisibilityGoLiveCache();
    const $queryRaw = jest.fn().mockResolvedValue([{ goLive: new Date('2026-11-05T09:31:00Z') }]);
    const prisma = { $queryRaw } as any;
    const t0 = Date.parse('2026-11-20T06:00:00Z');
    await visibilityPortalGoLive(prisma, 'a', t0);
    await visibilityPortalGoLive(prisma, 'a', t0 + 60_000);
    await visibilityPortalGoLive(prisma, 'a', t0 + 4 * 60_000);
    expect($queryRaw).toHaveBeenCalledTimes(1);
    await visibilityPortalGoLive(prisma, 'b', t0); // per tenant
    expect($queryRaw).toHaveBeenCalledTimes(2);
    await visibilityPortalGoLive(prisma, 'a', t0 + 5 * 60_000); // TTL expired
    expect($queryRaw).toHaveBeenCalledTimes(3);
    clearVisibilityGoLiveCache('a'); // a portal capture was created
    $queryRaw.mockResolvedValue([{ goLive: new Date('2026-11-01T09:31:00Z') }]);
    expect((await visibilityPortalGoLive(prisma, 'a', t0 + 5 * 60_000 + 1))?.toISOString()).toBe('2026-11-01T09:31:00.000Z');
    expect($queryRaw).toHaveBeenCalledTimes(4);
  });

  it('a new portal capture drops the cache only when the tenant had no go-live yet', async () => {
    clearVisibilityGoLiveCache();
    const $queryRaw = jest.fn().mockResolvedValue([{ goLive: null }]);
    const prisma = { $queryRaw } as any;
    const t0 = Date.parse('2026-11-20T06:00:00Z');
    expect(await visibilityPortalGoLive(prisma, 'n', t0)).toBeNull();
    noteVisibilityPortalCapture('n');
    $queryRaw.mockResolvedValue([{ goLive: new Date('2026-11-20T05:59:00Z') }]);
    expect(await visibilityPortalGoLive(prisma, 'n', t0 + 1)).not.toBeNull();
    expect($queryRaw).toHaveBeenCalledTimes(2);
    noteVisibilityPortalCapture('n'); // already live → cache kept
    await visibilityPortalGoLive(prisma, 'n', t0 + 2);
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });

  it('per window: old (ended before go-live) / part-old (began before go-live or holds imported) / portal', () => {
    const goLive = new Date('2026-11-05T09:31:00Z');
    const r = (s: string, e: string) => ({ start: new Date(s), end: new Date(e) });
    const none = { windowHoldsImported: false, scopeHoldsImported: false };
    expect(classifyWindowAgainstGoLive(r('2026-09-30T18:30:00Z', '2026-10-31T18:30:00Z'), goLive, none)).toBe('old');
    expect(classifyWindowAgainstGoLive(r('2026-10-31T18:30:00Z', '2026-11-30T18:30:00Z'), goLive, none)).toBe('part-old');
    expect(classifyWindowAgainstGoLive(r('2026-11-30T18:30:00Z', '2026-12-31T18:30:00Z'), goLive, none)).toBe('portal');
    expect(classifyWindowAgainstGoLive(r('2026-11-30T18:30:00Z', '2026-12-31T18:30:00Z'), goLive, { ...none, windowHoldsImported: true })).toBe('part-old');
    // No portal capture yet: old only when the reported scope holds imported captures.
    expect(classifyWindowAgainstGoLive(r('2025-05-31T18:30:00Z', '2025-06-30T18:30:00Z'), null, { windowHoldsImported: true, scopeHoldsImported: true })).toBe('old');
    expect(classifyWindowAgainstGoLive(r('2026-10-31T18:30:00Z', '2026-11-30T18:30:00Z'), null, none)).toBe('portal');
  });
});
