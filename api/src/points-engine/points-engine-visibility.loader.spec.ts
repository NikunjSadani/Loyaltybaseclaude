// Unit tests for the Points Compute Engine visibility (POSM) input loader (design §3a, owner decision 2026-11-25).
// Real-shaped capture rows (approved / rejected / changes-requested / waiting / imported / out-of-scope / several
// windows / late-loaded outlet / older frequency / open window / old-app window) + the AMOUNT_UPLOAD path + the
// unavailable cases. Prisma is mocked; the query SHAPE is asserted so the load stays tenant-scoped and N+1-free.
// Run: npx jest --no-coverage --maxWorkers=2 src/points-engine/points-engine-visibility.loader.spec.ts

import {
  loadVisibilityInputs,
  summarizeVisibility,
  visibilityContext,
  visibilityFactsFor,
  visibilityPendingKey,
} from './points-engine-visibility.loader';
import { evaluateRule } from './points-engine.helper';
import type { PointsRuleConfig } from './points-engine.types';
import { clearVisibilityGoLiveCache } from '../visibility/visibility-portal-go-live';

const mockPrisma = {
  visibilityCapture: { findMany: jest.fn() },
  outlet: { findMany: jest.fn() },
  outletVisibilityRecord: { findMany: jest.fn() },
  $queryRaw: jest.fn(),
};

const CFG2 = { outletScope: ['SSS'], frequencyPerMonth: 2, programs: [], subPrograms: [] };
// Well after the month → every window of 2026-10 is closed (the past-period universe is used).
const NOW = new Date('2026-11-25T06:00:00.000Z');
// Mid-window P2 of 2026-11 → P1 closed, P2 open.
const NOW_MID = new Date('2026-11-20T06:00:00.000Z');
const GO_LIVE = new Date('2026-08-01T00:00:00.000Z');

const SSS = { code: 'SSS' };
type LiveState = { deletedAt?: Date | null; deactivatedAt?: Date | null; isActive?: boolean; kycIntent?: string | null };
const LIVE: LiveState = { deletedAt: null, deactivatedAt: null, isActive: true, kycIntent: null };
function cap(outletCode: string, windowKey: string, status: string, outletType = SSS, state: LiveState = LIVE) {
  return { windowKey, status, outlet: { outletCode, programName: null, programCategory: null, outletType, ...LIVE, ...state } };
}

function goLiveSql(goLive: Date | null, importedKeys: string[] = []) {
  mockPrisma.$queryRaw.mockImplementation((q: { strings?: string[]; sql?: string }) => {
    const text = q.sql ?? (q.strings ?? []).join('?');
    if (text.includes('MIN(')) return Promise.resolve([{ goLive }]);
    return Promise.resolve(importedKeys.map((windowKey) => ({ windowKey })));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  clearVisibilityGoLiveCache();
  mockPrisma.visibilityCapture.findMany.mockResolvedValue([]);
  mockPrisma.outlet.findMany.mockResolvedValue([]);
  mockPrisma.outletVisibilityRecord.findMany.mockResolvedValue([]);
  goLiveSql(GO_LIVE);
});

const load = (config = CFG2, now = NOW, month = '2026-10') =>
  loadVisibilityInputs(mockPrisma as never, 'bajaj', month, { enabled: true, mode: 'PHOTO_APPROVAL', config, now });

describe('loadVisibilityInputs — PHOTO_APPROVAL', () => {
  it('counts APPROVED windows only (per-photo-derived final status), imported approvals included', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue(['A', 'B', 'C', 'D', 'E'].map((outletCode) => ({ outletCode })));
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([
      cap('A', '2026-10-P1', 'APPROVED'),
      cap('A', '2026-10-P2', 'APPROVED'),
      cap('B', '2026-10-P1', 'APPROVED'),
      cap('B', '2026-10-P2', 'CHANGES_REQUESTED'), // re-take asked (window closed) → not approved
      cap('C', '2026-10-P1', 'REJECTED'),
      cap('C', '2026-10-P2', 'SUBMITTED'), // waiting for review → not approved
      cap('D', '2026-10-P1', 'APPROVED'), // imported old-app approval (stored APPROVED) → counts
    ]);
    const data = await load();
    expect(data.available).toBe(true);
    const f = (code: string) => data.byOutlet.get(code)!;
    expect(f('A')).toMatchObject({ approvedWindows: 2, approved: 1, windows: 2, inScope: 1, scope: 'IN_SCOPE' });
    expect(f('B')).toMatchObject({ approvedWindows: 1, approved: 1, notApprovedWindows: 1 });
    expect(f('C')).toMatchObject({ approvedWindows: 0, approved: 0, waitingWindows: 1, notApprovedWindows: 1, openWindows: 0 });
    expect(f('C').note).toMatch(/0 of 2 windows approved \(1 waiting for review; 1 re-take requested \/ rejected\) → approved=0/);
    expect(f('D')).toMatchObject({ approvedWindows: 1, approved: 1 });
    expect(f('E')).toMatchObject({ approvedWindows: 0, approved: 0, inScope: 1, scope: 'IN_SCOPE' });
    expect(summarizeVisibility(data)).toMatchObject({
      outletsApproved: 3, outletsWithData: 5, windows: 2, outletsWaitingReview: 1, outletsOpenWindow: 0, outletsPending: 1,
    });
  });

  it('is tenant-scoped and bounded: 1 capture query for the month + 1 universe query per window', async () => {
    await load();
    expect(mockPrisma.visibilityCapture.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.visibilityCapture.findMany.mock.calls[0][0].where).toEqual({ clientId: 'bajaj', windowKey: { startsWith: '2026-10-P' } });
    expect(mockPrisma.outlet.findMany).toHaveBeenCalledTimes(2); // frequency 2 → 2 windows
    for (const [args] of mockPrisma.outlet.findMany.mock.calls) {
      expect(JSON.stringify(args.where)).toContain('"clientId":"bajaj"');
      expect(args.where.createdAt).toBeDefined(); // closed window → the dated (past-period) universe
    }
  });

  it('a LATE-LOADED live in-programme outlet: its APPROVED capture counts (only the DATES are relaxed)', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([]); // nobody is in a dated universe (created / KYC-approved after)
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([
      cap('L', '2026-10-P1', 'APPROVED'),
      cap('L', '2026-10-P2', 'SUBMITTED'), // not proven → not a visit due
      cap('W', '2026-10-P1', 'APPROVED', { code: 'WS' }), // wholesaler — not in the programme
      // In the programme by type, but NOT live today → excluded (only the dates are relaxed, never these rules):
      cap('D1', '2026-10-P1', 'APPROVED', SSS, { deactivatedAt: new Date('2026-11-01T00:00:00Z'), isActive: false }),
      cap('D2', '2026-10-P1', 'APPROVED', SSS, { isActive: false }), // not KYC-approved
      cap('D3', '2026-10-P1', 'APPROVED', SSS, { kycIntent: 'PARKED' }),
      cap('D4', '2026-10-P1', 'APPROVED', SSS, { kycIntent: 'NOT_INTERESTED' }),
      cap('D5', '2026-10-P1', 'APPROVED', SSS, { deletedAt: new Date('2026-11-01T00:00:00Z') }),
    ]);
    const data = await load();
    expect(data.byOutlet.get('L')).toMatchObject({ approvedWindows: 1, approved: 1, windows: 1, inScope: 1, countedOutsideDatedScope: 1 });
    expect(data.byOutlet.get('L')!.note).toMatch(/1 approval counted although the outlet was added \/ KYC-approved after the window/);
    for (const c of ['W', 'D1', 'D2', 'D3', 'D4', 'D5']) expect(data.byOutlet.has(c)).toBe(false);
    const s = summarizeVisibility(data);
    expect(s.countedOutsideDatedScope).toBe(1);
    expect(s.excluded).toEqual({ olderFrequency: 0, notInProgramme: 1, notLive: 5 });
    const w = visibilityFactsFor(data, { outletCode: 'W', outletType: { code: 'WS' } })!;
    expect(w).toMatchObject({ approved: 0, inScope: 0, scope: 'NOT_IN_SCOPE', excludedApprovals: { notInProgramme: 1, olderFrequency: 0, notLive: 0 } });
    expect(w.note).toMatch(/1 approved capture not counted — outlet not in the visibility programme/);
    const d = visibilityFactsFor(data, { outletCode: 'D3', outletType: SSS })!;
    expect(d.note).toMatch(/not counted — outlet removed \/ deactivated \/ not KYC-approved \/ parked/);
    // A run that does not include the excluded outlets (program filter / deleted) does not count them.
    expect(summarizeVisibility(data, new Set(['L'])).excluded).toEqual({ olderFrequency: 0, notInProgramme: 0, notLive: 0 });
  });

  it('OUT-of-scope outlets keep the month window count → `approvedWindows >= windows` does NOT pay them', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'A' }]);
    const data = await load();
    const rule: PointsRuleConfig = {
      ruleId: 'r', tenantId: 'bajaj', version: 1, status: 'published', effectiveFrom: '2026-01-01',
      attachsTo: { scope: 'program_kpi', kpiCode: 'TOTAL' }, evaluationBasis: 'PERIOD_AGGREGATE',
      output: { awardType: 'PAYOUT', fieldId: 'f' }, rounding: { mode: 'half_up', scale: 0 },
      inputs: [
        { ref: 'ok', source: 'visibility:approvedWindows', type: 'number', nullAs: 'reject' },
        { ref: 'n', source: 'visibility:windows', type: 'number', nullAs: 'reject' },
      ],
      pipeline: [{ type: 'milestone', id: 'm', when: { op: 'gte', left: { var: 'ok' }, right: { var: 'n' } }, flat: 500 }],
    };
    const run = (facts: ReturnType<typeof visibilityFactsFor>) =>
      evaluateRule(rule, { achievements: {}, targets: {}, segment: {}, visibility: visibilityContext(facts) });
    const ws = visibilityFactsFor(data, { outletCode: 'WS1', outletType: { code: 'WS' } })!;
    expect(ws).toMatchObject({ windows: 2, inScope: 0, approvedWindows: 0 });
    expect(run(ws)).toMatchObject({ status: 'OK', points: 0 });

    const upload = await loadVisibilityInputs(mockPrisma as never, 'kw', '2026-10', { enabled: true, mode: 'AMOUNT_UPLOAD', config: null, now: NOW });
    const none = visibilityFactsFor(upload, { outletCode: 'Z' })!;
    expect(none).toMatchObject({ windows: 1, inScope: 0, approvedWindows: 0 });
    expect(run(none)).toMatchObject({ status: 'OK', points: 0 });
  });

  it('per-outlet windows = the windows the outlet was in scope for (joined mid-month → 1 of 1)', async () => {
    mockPrisma.outlet.findMany
      .mockResolvedValueOnce([{ outletCode: 'A' }]) // P1 universe
      .mockResolvedValueOnce([{ outletCode: 'A' }, { outletCode: 'N' }]); // P2 universe — N joined
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([cap('N', '2026-10-P2', 'APPROVED')]);
    const data = await load();
    expect(data.byOutlet.get('A')).toMatchObject({ windows: 2, approvedWindows: 0 });
    expect(data.byOutlet.get('N')).toMatchObject({ windows: 1, approvedWindows: 1, approved: 1 });
    expect(visibilityContext(data.byOutlet.get('N')!)).toEqual({ approvedWindows: 1, approved: 1, windows: 1, inScope: 1 });
  });

  it('an approval under an OLDER frequency (window key the current frequency lacks) is not counted but reported', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'A' }]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([cap('A', '2026-10-P3', 'APPROVED')]);
    const data = await load();
    expect(data.byOutlet.get('A')).toMatchObject({ approvedWindows: 0, excludedApprovals: { olderFrequency: 1, notInProgramme: 0, notLive: 0 } });
    expect(data.byOutlet.get('A')!.note).toMatch(/1 approval under an older capture frequency not counted/);
    expect(summarizeVisibility(data).excluded.olderFrequency).toBe(1);
  });

  it('an OPEN window without an approval is pending (counted per outlet + in the summary)', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'A' }, { outletCode: 'B' }]);
    mockPrisma.visibilityCapture.findMany.mockResolvedValue([
      cap('A', '2026-11-P1', 'APPROVED'),
      cap('A', '2026-11-P2', 'APPROVED'),
      cap('B', '2026-11-P1', 'APPROVED'),
    ]);
    const data = await load(CFG2, NOW_MID, '2026-11');
    expect(data.openWindowsInMonth).toBe(1);
    expect(data.byOutlet.get('A')).toMatchObject({ openWindows: 0, approvedWindows: 2 });
    expect(data.byOutlet.get('B')).toMatchObject({ openWindows: 1, approvedWindows: 1 });
    expect(data.byOutlet.get('B')!.note).toMatch(/1 window still open/);
    const s = summarizeVisibility(data);
    expect(s).toMatchObject({ outletsOpenWindow: 1, outletsWaitingReview: 0, outletsPending: 1, openOutletCodes: ['B'], waitingOutletCodes: [] });
    // The acceptance key binds the EXACT pending outlet set: same set → same key; another outlet → another key.
    expect(s.pendingKey).toBe(visibilityPendingKey('2026-11', [], ['B']));
    expect(s.pendingKey).not.toBe(visibilityPendingKey('2026-11', [], ['A']));
    // A run narrowed to outlet A only (program filter) has nothing pending → no key.
    const onlyA = summarizeVisibility(data, new Set(['A']));
    expect(onlyA.outletsPending).toBe(0);
    expect(onlyA.pendingKey).toBe('');
  });

  it('a closed window partly on the old app with no capture says so (the report marker), not a plain 0', async () => {
    goLiveSql(new Date('2026-10-10T00:00:00.000Z')); // portal went live inside P1 of 2026-10
    mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'A' }]);
    const data = await load();
    expect(data.byOutlet.get('A')!.note).toMatch(/P1: No approved record — part of this window was on the old app/);
  });

  it('an outlet outside the visibility scope gets real zeros + inScope 0 + a "not in visibility scope" note', async () => {
    mockPrisma.outlet.findMany.mockResolvedValue([{ outletCode: 'A' }]);
    const data = await load();
    const ws = visibilityFactsFor(data, { outletCode: 'WS1', outletType: { code: 'WS' }, programName: null, programCategory: null })!;
    expect(ws).toMatchObject({ approvedWindows: 0, approved: 0, windows: 2, inScope: 0, scope: 'NOT_IN_SCOPE' });
    expect(ws.note).toMatch(/not in visibility scope \(outlet type WS/);
    const pending = visibilityFactsFor(data, { outletCode: 'P1', outletType: { code: 'SSS' } })!;
    expect(pending.note).toMatch(/not live and KYC-approved/);
  });

  it('switched off / no outlet scope → unavailable (inputs ABSENT → nullAs), no capture query', async () => {
    const off = await loadVisibilityInputs(mockPrisma as never, 'deoleo', '2026-10', {
      enabled: false, mode: 'PHOTO_APPROVAL', config: CFG2, now: NOW,
    });
    expect(off.available).toBe(false);
    expect(off.unavailableReason).toMatch(/switched off/);
    expect(visibilityFactsFor(off, { outletCode: 'A' })).toBeNull();
    expect(visibilityContext(null)).toBeUndefined();
    const noScope = await load({ ...CFG2, outletScope: [] });
    expect(noScope.available).toBe(false);
    expect(noScope.unavailableReason).toMatch(/No outlet types/);
    expect(mockPrisma.visibilityCapture.findMany).not.toHaveBeenCalled();
  });
});

describe('loadVisibilityInputs — AMOUNT_UPLOAD', () => {
  it('reads the month’s uploaded status records: APPROVED → 1 of 1, other statuses → 0 + pending, no record → NO_RECORD', async () => {
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
    expect(data.byOutlet.get('A')).toMatchObject({ approvedWindows: 1, approved: 1, windows: 1, inScope: 1 });
    expect(data.byOutlet.get('B')).toMatchObject({ approved: 0, waitingWindows: 1 });
    expect(data.byOutlet.get('B')!.note).toMatch(/UNDER_REVIEW — not approved yet/);
    expect(summarizeVisibility(data)).toMatchObject({ outletsWaitingReview: 2, outletsPending: 2 });
    const none = visibilityFactsFor(data, { outletCode: 'Z' })!;
    expect(none).toMatchObject({ approved: 0, inScope: 0, scope: 'NO_RECORD' });
  });
});
