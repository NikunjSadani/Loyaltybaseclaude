// Unit tests for the Points Compute Engine visibility (POSM) input loader (design §3a, owner decision 2026-11-25).
// Real-shaped capture rows (approved / rejected / changes-requested / waiting / imported / out-of-scope / several
// windows) + the AMOUNT_UPLOAD path + the unavailable cases. Prisma is mocked; the query SHAPE is asserted so the
// load stays tenant-scoped and N+1-free.
// Run: npx jest --no-coverage --maxWorkers=2 src/points-engine/points-engine-visibility.loader.spec.ts

import {
  loadVisibilityInputs,
  summarizeVisibility,
  visibilityContext,
  visibilityFactsFor,
} from './points-engine-visibility.loader';

const mockPrisma = {
  visibilityCapture: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  outletVisibilityRecord: { findMany: jest.fn() },
};

const CFG2 = { outletScope: ['SSS'], frequencyPerMonth: 2, programs: [], subPrograms: [] };
// A "now" well after the month, so every window of 2026-10 is closed (the past-period universe is used).
const NOW = new Date('2026-11-25T06:00:00.000Z');
const IMPORTED_PHOTO = { key: 'visibility-media/bajaj/vendor-import/abc.jpg' };

function cap(outletCode: string, windowKey: string, status: string, formValues: unknown = {}) {
  return { windowKey, status, formValues, outlet: { outletCode } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
  mockPrisma.outlet.findMany.mockResolvedValue([]);
  mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([]);
});

describe('loadVisibilityInputs — PHOTO_APPROVAL', () => {
  it('counts APPROVED windows only (per-photo-derived final status), imported approvals included', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([
      { outletCode: 'A' }, { outletCode: 'B' }, { outletCode: 'C' }, { outletCode: 'D' }, { outletCode: 'E' },
    ]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([
      cap('A', '2026-10-P1', 'APPROVED'),
      cap('A', '2026-10-P2', 'APPROVED'), // both windows approved
      cap('B', '2026-10-P1', 'APPROVED'),
      cap('B', '2026-10-P2', 'CHANGES_REQUESTED'), // re-take asked (window closed) → not approved
      cap('C', '2026-10-P1', 'REJECTED'),
      cap('C', '2026-10-P2', 'SUBMITTED'), // waiting for review → not approved
      cap('D', '2026-10-P1', 'APPROVED', { f1: IMPORTED_PHOTO }), // imported old-app approval → counts
    ]);

    const data = await loadVisibilityInputs(mockPrisma as never, 'bajaj', '2026-10', {
      enabled: true, mode: 'PHOTO_APPROVAL', config: CFG2, now: NOW,
    });

    expect(data.available).toBe(true);
    expect(data.windows).toBe(2);
    const f = (code: string) => data.byOutlet.get(code)!;
    expect(f('A')).toMatchObject({ approvedWindows: 2, approved: 1, windows: 2, scope: 'IN_SCOPE' });
    expect(f('B')).toMatchObject({ approvedWindows: 1, approved: 1, notApprovedWindows: 1 });
    expect(f('C')).toMatchObject({ approvedWindows: 0, approved: 0, waitingWindows: 1, notApprovedWindows: 1 });
    expect(f('C').note).toMatch(/0 of 2 windows approved \(1 waiting for review, 1 re-take requested \/ rejected\) → approved=0/);
    expect(f('D')).toMatchObject({ approvedWindows: 1, approved: 1 });
    // In scope, no capture at all → a real 0 (IN_SCOPE), not "not in scope".
    expect(f('E')).toMatchObject({ approvedWindows: 0, approved: 0, scope: 'IN_SCOPE' });

    expect(summarizeVisibility(data)).toMatchObject({ outletsApproved: 3, outletsWithData: 5, windows: 2 });
  });

  it('loads in TWO tenant-scoped queries with one universe per window of the month (no N+1)', async () => {
    await loadVisibilityInputs(mockPrisma as never, 'bajaj', '2026-10', {
      enabled: true, mode: 'PHOTO_APPROVAL', config: CFG2, now: NOW,
    });
    expect(mockPrisma.visibilityCapture.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.outlet.findMany).toHaveBeenCalledTimes(1);
    const capWhere = mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where;
    expect(capWhere.clientId).toBe('bajaj');
    expect(capWhere.OR.map((o: { windowKey: string }) => o.windowKey)).toEqual(['2026-10-P1', '2026-10-P2']);
    // Every per-window universe is tenant-scoped (closed windows → the past-period rule: createdAt < window end).
    for (const o of capWhere.OR) {
      expect(JSON.stringify(o.outlet)).toContain('"clientId":"bajaj"');
      expect(o.outlet.createdAt).toBeDefined();
    }
    const outWhere = mockPrisma.outlet.findMany.mock.calls[0][0].where;
    expect(outWhere.OR).toHaveLength(2);
  });

  it('an outlet outside the visibility scope gets real zeros + a "not in visibility scope" note', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'A' }]);
    const data = await loadVisibilityInputs(mockPrisma as never, 'bajaj', '2026-10', {
      enabled: true, mode: 'PHOTO_APPROVAL', config: CFG2, now: NOW,
    });
    const ws = visibilityFactsFor(data, { outletCode: 'WS1', outletType: { code: 'WS' }, programName: null, programCategory: null })!;
    expect(ws).toMatchObject({ approvedWindows: 0, approved: 0, windows: 2, scope: 'NOT_IN_SCOPE' });
    expect(ws.note).toMatch(/not in visibility scope \(outlet type WS/);
    // Right type but not live/KYC-approved in the month's windows → also out of scope, different reason.
    const pending = visibilityFactsFor(data, { outletCode: 'P1', outletType: { code: 'SSS' } })!;
    expect(pending.scope).toBe('NOT_IN_SCOPE');
    expect(pending.note).toMatch(/not live and KYC-approved/);
    expect(visibilityContext(ws)).toEqual({ approvedWindows: 0, approved: 0, windows: 2 });
  });

  it('switched off / no outlet scope → unavailable (inputs ABSENT → nullAs), no capture query', async () => {
    const off = await loadVisibilityInputs(mockPrisma as never, 'deoleo', '2026-10', {
      enabled: false, mode: 'PHOTO_APPROVAL', config: CFG2, now: NOW,
    });
    expect(off.available).toBe(false);
    expect(off.unavailableReason).toMatch(/switched off/);
    expect(visibilityFactsFor(off, { outletCode: 'A' })).toBeNull();
    expect(visibilityContext(null)).toBeUndefined();

    const noScope = await loadVisibilityInputs(mockPrisma as never, 'bajaj', '2026-10', {
      enabled: true, mode: 'PHOTO_APPROVAL', config: { ...CFG2, outletScope: [] }, now: NOW,
    });
    expect(noScope.available).toBe(false);
    expect(noScope.unavailableReason).toMatch(/No outlet types/);
    expect(mockPrisma.visibilityCapture.findMany).not.toHaveBeenCalled();
  });
});

describe('loadVisibilityInputs — AMOUNT_UPLOAD', () => {
  it('reads the month’s uploaded status records: APPROVED → 1 of 1, other statuses → 0, no record → 0 (NO_RECORD)', async () => {
    mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([
      { outletCode: 'A', status: 'APPROVED' },
      { outletCode: 'B', status: 'UNDER_REVIEW' },
      { outletCode: 'C', status: 'PENDING' },
    ]);
    const data = await loadVisibilityInputs(mockPrisma as never, 'kw', '2026-10', {
      enabled: true, mode: 'AMOUNT_UPLOAD', config: null, now: NOW,
    });
    expect(mockPrisma.outletVisibilityRecord.findMany).toHaveBeenCalledWith({
      where: { clientId: 'kw', month: '2026-10' },
      select: { outletCode: true, status: true },
    });
    expect(mockPrisma.visibilityCapture.findMany).not.toHaveBeenCalled();
    expect(data.windows).toBe(1);
    expect(data.byOutlet.get('A')).toMatchObject({ approvedWindows: 1, approved: 1, windows: 1 });
    expect(data.byOutlet.get('B')).toMatchObject({ approvedWindows: 0, approved: 0 });
    expect(data.byOutlet.get('B')!.note).toMatch(/UNDER_REVIEW — not approved/);
    expect(data.byOutlet.get('C')).toMatchObject({ approved: 0 });
    const none = visibilityFactsFor(data, { outletCode: 'Z' })!;
    expect(none).toMatchObject({ approved: 0, scope: 'NO_RECORD' });
    expect(none.note).toMatch(/no visibility status uploaded/);
  });
});
