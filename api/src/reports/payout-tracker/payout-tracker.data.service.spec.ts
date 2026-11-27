import { PayoutTrackerDataService } from './payout-tracker.data.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { PointsComputeService } from '../../points-engine/points-compute.service';
import type { TenantSettingsService } from '../../tenant/tenant-settings.service';
import type { ComputePreview, ComputePreviewRow } from '../../points-engine/points-compute.types';

// ─── fixtures ───────────────────────────────────────────────────────────────────────────────────────────
const NOW = new Date('2026-11-27T04:00:00.000Z');

function outletRow(code: string, over: Record<string, unknown> = {}) {
  return {
    id: `o_${code}`,
    outletCode: code,
    name: `Shop ${code}`,
    ownerName: `Owner ${code}`,
    zone: 'North',
    state: 'Punjab',
    city: 'Patiala',
    beat: 'B1',
    metro: 'Metro',
    distributorCode: '5000',
    distributorName: 'DB One',
    programName: 'Unnati',
    programCategory: 'Unnati',
    partnerId: `p_${code}`,
    outletType: { code: 'SSS', name: 'SSS' },
    partner: { ownerName: `Partner ${code}` } as { ownerName: string } | null,
    ...over,
  };
}

function su(id: string, level: string, reportingToId: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    employeeCode: `HQ-${id}`,
    reportingToId,
    isActive: true,
    deletedAt: null,
    hierarchyLevel: { code: level },
    user: { name: `Name ${id}` },
    ...over,
  };
}

function row(code: string, kpiCode: string, over: Partial<ComputePreviewRow> = {}): ComputePreviewRow {
  return { outletCode: code, kpiCode, status: 'OK', awardType: 'PAYOUT', payoutRupees: 0, ...over };
}

function preview(rows: ComputePreviewRow[], over: Partial<ComputePreview> = {}): ComputePreview {
  return {
    clientId: 'bajaj',
    period: '2026-11',
    counts: { total: rows.length, ok: 0, skip: 0, error: 0, noRule: 0 },
    totalPoints: 0,
    totalPayoutRupees: 0,
    rows,
    engineDisabled: false,
    directCreditEnabled: false,
    ruleVersionsUsed: [],
    sourceKey: 'k',
    payoutKey: 'p',
    ...over,
  };
}

interface World {
  outlets: ReturnType<typeof outletRow>[];
  targets: Array<{ outletCode: string; targetValues: unknown }>;
  sales: Array<{ outletCode: string; kpiValues: unknown; updatedAt: Date }>;
  lastMonth: Array<{ outletCode: string; kpiValues: unknown }>;
  assignments: Array<{ outletId: string; salesUserId: string; assignedAt: Date }>;
  salesUsers: ReturnType<typeof su>[];
  kyc: Array<{ partnerId: string }>;
  captures: Array<{ outletCode: string; status: string }>;
  monthStatus: { state: string; lastAppliedAt?: Date | null } | null;
  daySet: { lastDay: number } | null;
  client: { id: string; internalName: string; branding: unknown } | null;
  firstLiveMonth: string | null;
  monthly: ComputePreview;
  quarterly: ComputePreview | null;
  rules: Array<{ ruleId: string; version: number; name?: string | null; inputs: unknown }>;
}

const VIS_RULE = { ruleId: 'R-VIS', version: 1, name: 'Unnati visibility', inputs: [{ id: 'aw', source: 'visibility:approvedWindows' }] };
const PLAIN_RULE = { ruleId: 'R-PLAIN', version: 2, name: 'Plain total', inputs: [{ id: 'a', source: 'achievement:TOTAL' }] };

function baseWorld(): World {
  return {
    outlets: [outletRow('U1')],
    targets: [{ outletCode: 'U1', targetValues: { TOTAL: 4000, ADHO: 3600, __names: { TOTAL: 'Total' } } }],
    sales: [{ outletCode: 'U1', kpiValues: { TOTAL: 5000, ADHO: '4000.5', 'BSC CASES': 3 }, updatedAt: new Date('2026-11-26T20:00:00.000Z') }],
    lastMonth: [{ outletCode: 'U1', kpiValues: { TOTAL: 1234 } }],
    assignments: [],
    salesUsers: [],
    kyc: [],
    captures: [],
    monthStatus: { state: 'OPEN' },
    daySet: { lastDay: 26 },
    client: { id: 'bajaj', internalName: 'bajaj', branding: { displayName: 'Bajaj Consumer Care' } },
    firstLiveMonth: '2026-11',
    monthly: preview([]),
    quarterly: null,
    rules: [VIS_RULE, PLAIN_RULE],
  };
}

function makeService(w: World) {
  const prisma = {
    outletTarget: { findMany: jest.fn().mockImplementation(() => Promise.resolve(w.targets)) },
    outletSalesRecord: {
      findMany: jest.fn().mockImplementation((args: { where: { month: string } }) =>
        Promise.resolve(args.where.month === '2026-11' || args.where.month === w.monthly.period ? w.sales : w.lastMonth),
      ),
    },
    outlet: {
      findMany: jest.fn().mockImplementation((args: { where: { outletCode: { in: string[] } } }) =>
        Promise.resolve(w.outlets.filter((o) => args.where.outletCode.in.includes(o.outletCode))),
      ),
    },
    salesUserAssignment: { findMany: jest.fn().mockImplementation(() => Promise.resolve(w.assignments)) },
    salesUser: { findMany: jest.fn().mockImplementation(() => Promise.resolve(w.salesUsers)) },
    kycSubmission: { findMany: jest.fn().mockImplementation(() => Promise.resolve(w.kyc)) },
    visibilityCapture: { findMany: jest.fn().mockImplementation(() => Promise.resolve(w.captures)) },
    salesMonthStatus: { findUnique: jest.fn().mockImplementation(() => Promise.resolve(w.monthStatus)) },
    salesDaySet: { findUnique: jest.fn().mockImplementation(() => Promise.resolve(w.daySet)) },
    client: { findUnique: jest.fn().mockImplementation(() => Promise.resolve(w.client)) },
    pointsRule: {
      findMany: jest.fn().mockImplementation((args: { where: { ruleId: { in: string[] } } }) =>
        Promise.resolve(w.rules.filter((r) => args.where.ruleId.in.includes(r.ruleId))),
      ),
    },
  };
  const engine = {
    previewCompute: jest.fn().mockImplementation((_u: unknown, opts: { period: string }) =>
      Promise.resolve(/-Q\d$/.test(opts.period) ? w.quarterly : w.monthly),
    ),
  };
  const settings = {
    getEffectiveSettings: jest.fn().mockImplementation(() =>
      Promise.resolve({ pointsEngine: { enabled: true, directCreditEnabled: false, firstLiveMonth: w.firstLiveMonth } }),
    ),
  };
  const svc = new PayoutTrackerDataService(
    prisma as unknown as PrismaService,
    engine as unknown as PointsComputeService,
    settings as unknown as TenantSettingsService,
  );
  return { svc, prisma, engine, settings };
}

/** The texts of one audience's notes, joined. */
const notesOf = (out: { notes: Array<{ audience: string; text: string }> }, audience: 'client' | 'ops', sep: string) =>
  out.notes.filter((n) => n.audience === audience).map((n) => n.text).join(sep);

type Out = Awaited<ReturnType<PayoutTrackerDataService['buildInput']>>;
/** Owner 2026-11-27: a per-outlet rule/config problem HOLDS BACK that outlet (off the report) — the run still goes out. */
function expectHeld(out: Out, code: string, programme: string, why: RegExp, heldCount = 1) {
  expect(out.outlets.map((o) => o.code)).not.toContain(code);
  expect(notesOf(out, 'client', '\n')).toContain(`${heldCount} outlet(s) held back pending a data check — they will appear once fixed.`);
  expect(notesOf(out, 'client', '\n')).not.toContain(code); // client never sees codes / rule text
  const line = out.notes.filter((n) => n.audience === 'ops').map((n) => n.text).find((t) => t.includes(`Held back: ${code} (`));
  expect(line).toBeDefined();
  expect(line).toContain(`(${programme}`);
  expect(line).toMatch(why);
}

const only = async (w: World, month = '2026-11', now = NOW) => {
  const { svc } = makeService(w);
  const out = await svc.buildInput('bajaj', month, now);
  return out;
};

// ─── tests ──────────────────────────────────────────────────────────────────────────────────────────────
describe('PayoutTrackerDataService.buildInput', () => {
  it('builds month meta, master fields, targets (no __names) and achievements', async () => {
    const out = await only(baseWorld());
    expect(out).toMatchObject({
      clientName: 'Bajaj Consumer Care',
      month: '2026-11',
      monthLabel: 'November 2026',
      quarterLabel: 'Oct–Dec 2026',
      bonusPaidIn: 'December 2026',
      isQuarterEnd: false,
      provisional: true,
      salesAsOf: '26 Nov 2026', // SalesDaySet.lastDay — the last invoice day in the applied file
    });
    expect(out.outlets).toHaveLength(1);
    const o = out.outlets[0];
    expect(o).toMatchObject({
      code: 'U1', name: 'Shop U1', ownerName: 'Partner U1', zone: 'North', state: 'Punjab', town: 'Patiala', beat: 'B1',
      metro: 'Metro', sapCode: '5000', dbName: 'DB One', program: 'Unnati', subProgram: 'Unnati',
      outletTypeCode: 'SSS', outletTypeLabel: 'SSS', gifsyApproved: false, visibility: null, chain: [],
      lastMonthTotal: 1234,
    });
    expect(o.targets).toEqual({ TOTAL: 4000, ADHO: 3600 });
    expect(o.achievements).toEqual({ TOTAL: 5000, ADHO: 4000.5, 'BSC CASES': 3 });
    expect(o.consistencyBonus).toBeNull();
  });

  it('outlet universe = union of target + sales codes; deleted / unknown codes are dropped LOUDLY (notes)', async () => {
    const w = baseWorld();
    w.targets.push({ outletCode: 'T2', targetValues: { TOTAL: 100 } });
    w.sales.push({ outletCode: 'S3', kpiValues: { TOTAL: 1 }, updatedAt: new Date('2026-11-01T00:00:00Z') });
    w.sales.push({ outletCode: 'GONE', kpiValues: { TOTAL: 1 }, updatedAt: new Date('2026-11-01T00:00:00Z') });
    w.outlets.push(outletRow('T2'), outletRow('S3'));
    const { svc, prisma } = makeService(w);
    const out = await svc.buildInput('bajaj', '2026-11', NOW);
    expect(out.outlets.map((o) => o.code).sort()).toEqual(['S3', 'T2', 'U1']);
    expect(out.outlets.find((o) => o.code === 'T2')!.achievements).toEqual({});
    expect(notesOf(out, 'ops', ' ')).toMatch(/1 outlet code.*GONE/);
    expect(notesOf(out, 'client', ' ')).not.toMatch(/GONE/); // housekeeping never reaches the client
    const where = prisma.outlet.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ clientId: 'bajaj', deletedAt: null });
    expect(prisma.outlet.findMany).toHaveBeenCalledTimes(1);
  });

  it('gifsyApproved = partner has an APPROVED KycSubmission', async () => {
    const w = baseWorld();
    w.outlets.push(outletRow('U2'), outletRow('U3', { partnerId: null }));
    w.targets.push({ outletCode: 'U2', targetValues: {} }, { outletCode: 'U3', targetValues: {} });
    w.kyc = [{ partnerId: 'p_U1' }];
    const { svc, prisma } = makeService(w);
    const out = await svc.buildInput('bajaj', '2026-11', NOW);
    const by = new Map(out.outlets.map((o) => [o.code, o]));
    expect(by.get('U1')!.gifsyApproved).toBe(true);
    expect(by.get('U2')!.gifsyApproved).toBe(false);
    expect(by.get('U3')!.gifsyApproved).toBe(false);
    expect(prisma.kycSubmission.findMany.mock.calls[0][0].where).toMatchObject({ status: 'APPROVED', partnerId: { in: ['p_U1', 'p_U2'] } });
  });

  it('chain: newest active assignment → reportingTo upwards; inactive/deleted = not active; cycle + depth guarded', async () => {
    const w = baseWorld();
    w.outlets.push(outletRow('C2'), outletRow('C3'));
    w.targets.push({ outletCode: 'C2', targetValues: {} }, { outletCode: 'C3', targetValues: {} });
    w.salesUsers = [
      su('isr1', 'XSR', 'so1'),
      su('isr_old', 'XSR', null),
      su('so1', 'SO', 'asm1', { isActive: false }), // vacant
      su('asm1', 'ASM', 'rsm1', { deletedAt: new Date() }),
      su('rsm1', 'RSM', null, { user: null }),
      // cycle a → b → a
      su('a', 'XSR', 'b'),
      su('b', 'SO', 'a'),
      // deep chain d0 → d1 → … → d11
      ...Array.from({ length: 12 }, (_, i) => su(`d${i}`, `L${i}`, i < 11 ? `d${i + 1}` : null)),
    ];
    w.assignments = [
      // ordered newest first (the query orders by assignedAt desc)
      { outletId: 'o_U1', salesUserId: 'isr1', assignedAt: new Date('2026-10-01') },
      { outletId: 'o_U1', salesUserId: 'isr_old', assignedAt: new Date('2026-01-01') },
      { outletId: 'o_C2', salesUserId: 'a', assignedAt: new Date('2026-10-01') },
      { outletId: 'o_C3', salesUserId: 'd0', assignedAt: new Date('2026-10-01') },
    ];
    const { svc, prisma } = makeService(w);
    const out = await svc.buildInput('bajaj', '2026-11', NOW);
    const by = new Map(out.outlets.map((o) => [o.code, o]));
    expect(by.get('U1')!.chain).toEqual([
      { level: 'XSR', hq: 'HQ-isr1', name: 'Name isr1', active: true },
      { level: 'SO', hq: 'HQ-so1', name: 'Name so1', active: false },
      { level: 'ASM', hq: 'HQ-asm1', name: 'Name asm1', active: false },
      { level: 'RSM', hq: 'HQ-rsm1', name: null, active: true },
    ]);
    expect(by.get('C2')!.chain.map((l) => l.hq)).toEqual(['HQ-a', 'HQ-b']);
    expect(by.get('C3')!.chain).toHaveLength(8);
    expect(prisma.salesUserAssignment.findMany.mock.calls[0][0]).toMatchObject({
      where: { unassignedAt: null, outletId: { in: expect.arrayContaining(['o_U1', 'o_C2', 'o_C3']) } },
      orderBy: { assignedAt: 'desc' },
    });
    expect(prisma.salesUser.findMany).toHaveBeenCalledTimes(1);
    expect(notesOf(out, 'ops', ' ')).toMatch(/cycle/i);
  });

  it('cycle / depth notes list EVERY affected outlet (also outlets sharing the same leaf), uncapped', async () => {
    const w = baseWorld();
    w.salesUsers = [su('a', 'XSR', 'b'), su('b', 'SO', 'a')];
    w.assignments = [];
    for (let i = 0; i < 25; i++) {
      w.outlets.push(outletRow(`Y${i}`));
      w.targets.push({ outletCode: `Y${i}`, targetValues: {} });
      w.assignments.push({ outletId: `o_Y${i}`, salesUserId: 'a', assignedAt: new Date('2026-10-01') });
    }
    const out = await only(w);
    const note = out.notes.find((n) => n.audience === 'ops' && /cycle/i.test(n.text))!.text;
    for (let i = 0; i < 25; i++) expect(note).toContain(`Y${i}`);
    expect(note).not.toMatch(/more\)/);
  });

  it('visibility precedence: APPROVED > SUBMITTED > CHANGES_REQUESTED > REJECTED > null', async () => {
    const w = baseWorld();
    const codes = ['V1', 'V2', 'V3', 'V4', 'V5'];
    for (const c of codes) {
      w.outlets.push(outletRow(c));
      w.targets.push({ outletCode: c, targetValues: {} });
    }
    w.captures = [
      { outletCode: 'V1', status: 'REJECTED' }, { outletCode: 'V1', status: 'APPROVED' }, { outletCode: 'V1', status: 'SUBMITTED' },
      { outletCode: 'V2', status: 'REJECTED' }, { outletCode: 'V2', status: 'SUBMITTED' },
      { outletCode: 'V3', status: 'REJECTED' }, { outletCode: 'V3', status: 'CHANGES_REQUESTED' },
      { outletCode: 'V4', status: 'REJECTED' },
    ];
    const { svc, prisma } = makeService(w);
    const out = await svc.buildInput('bajaj', '2026-11', NOW);
    const v = Object.fromEntries(out.outlets.map((o) => [o.code, o.visibility]));
    expect(v).toMatchObject({ V1: 'APPROVED', V2: 'SUBMITTED', V3: 'CHANGES_REQUESTED', V4: 'REJECTED', V5: null });
    expect(prisma.visibilityCapture.findMany.mock.calls[0][0].where).toMatchObject({ clientId: 'bajaj', windowKey: { startsWith: '2026-11-' } });
  });

  it('lastMonthTotal: null when no record last month; 0 when a record has no / blank TOTAL', async () => {
    const w = baseWorld();
    w.outlets.push(outletRow('L0'), outletRow('LN'));
    w.targets.push({ outletCode: 'L0', targetValues: {} }, { outletCode: 'LN', targetValues: {} });
    w.lastMonth.push({ outletCode: 'L0', kpiValues: { ADHO: 5 } });
    const { svc, prisma } = makeService(w);
    const out = await svc.buildInput('bajaj', '2026-11', NOW);
    const by = new Map(out.outlets.map((o) => [o.code, o]));
    expect(by.get('U1')!.lastMonthTotal).toBe(1234);
    expect(by.get('L0')!.lastMonthTotal).toBe(0);
    expect(by.get('LN')!.lastMonthTotal).toBeNull();
    expect(prisma.outletSalesRecord.findMany.mock.calls.map((c: [{ where: { month: string } }]) => c[0].where.month).sort()).toEqual(['2026-10', '2026-11']);
  });

  it('January: last month = December of the previous year; quarter Jan–Mar; paid in March', async () => {
    const w = baseWorld();
    w.firstLiveMonth = '2026-11';
    w.monthly = preview([], { period: '2027-01' });
    const { svc, prisma } = makeService(w);
    const out = await svc.buildInput('bajaj', '2027-01', new Date('2027-01-10T00:00:00Z'));
    expect(out).toMatchObject({ monthLabel: 'January 2027', quarterLabel: 'Jan–Mar 2027', bonusPaidIn: 'March 2027', isQuarterEnd: false });
    expect(prisma.outletSalesRecord.findMany.mock.calls.map((c: [{ where: { month: string } }]) => c[0].where.month)).toContain('2026-12');
  });

  it('RLP engine mapping: Unnati parts by KPI; TOTAL rule with visibility = VISIBILITY; SAMT TOTAL = TOTAL; reasons kept on 0', async () => {
    const w = baseWorld();
    w.outlets.push(outletRow('S1', { programName: 'SAMT', programCategory: 'Privilege' }));
    w.targets.push({ outletCode: 'S1', targetValues: {} });
    const vis = { approvedWindows: 1, approved: 1 as const, windows: 1, inScope: 1 as const, scope: 'IN_SCOPE' as const, waitingWindows: 0, openWindows: 0, excludedApprovals: { olderFrequency: 0, notInProgramme: 0 }, note: 'n' };
    w.monthly = preview([
      row('U1', 'ADHO', { payoutRupees: 98 }),
      row('U1', 'NON ADHO', { payoutRupees: 0, reason: 'NON ADHO below target' }),
      row('U1', 'FOCUS BRAND', { status: 'SKIP', reason: 'KPI not applicable', skipKind: 'KPI_SCOPE', payoutRupees: undefined }),
      row('U1', 'LINES', { payoutRupees: 100 }),
      row('U1', 'TOTAL', { payoutRupees: 500, visibility: vis, ruleId: 'R-VIS', ruleVersion: 1 }),
      row('U1', 'FOCUS BRAND 2', { status: 'NO_RULE', reason: 'No active rule for this attachment.', payoutRupees: undefined }),
      row('S1', 'TOTAL', { payoutRupees: 0, reason: 'Visibility not approved', visibility: { ...vis, approved: 0 }, ruleId: 'R-VIS', ruleVersion: 1 }),
      row('S1', 'LINES', { payoutRupees: 150 }),
      row('S1', 'ADHO', { status: 'NO_RULE', payoutRupees: undefined }),
    ]);
    const out = await only(w);
    const by = new Map(out.outlets.map((o) => [o.code, o]));
    expect(by.get('U1')!.payout).toEqual({
      ADHO: { amount: 98, reason: null },
      'NON ADHO': { amount: 0, reason: 'NON ADHO below target' },
      LINES: { amount: 100, reason: null },
      VISIBILITY: { amount: 500, reason: null },
    });
    expect(by.get('U1')!.bsc).toBeUndefined();
    expect(by.get('S1')!.payout).toEqual({
      TOTAL: { amount: 0, reason: 'Visibility not approved' },
      LINES: { amount: 150, reason: null },
    });
    // NO_RULE on KPIs with no column for the programme → listed in a data note, never dropped silently.
    expect(notesOf(out, 'ops', ' ')).toMatch(/FOCUS BRAND 2.*U1/);
    expect(notesOf(out, 'ops', ' ')).toMatch(/ADHO.*S1/);
  });

  it('B3: the Unnati visibility part is identified from the RULE inputs, not from row.visibility', async () => {
    const w = baseWorld();
    // A plain TOTAL rule that happens to carry visibility facts is still refused (rule does not read visibility).
    w.monthly = preview([row('U1', 'TOTAL', { payoutRupees: 300, ruleId: 'R-PLAIN', ruleVersion: 2, visibility: { approvedWindows: 1, approved: 1, windows: 1, inScope: 1, scope: 'IN_SCOPE', waitingWindows: 0, openWindows: 0, excludedApprovals: { olderFrequency: 0, notInProgramme: 0 }, note: '' } })]);
    expectHeld(await only(w), 'U1', 'Unnati', /TOTAL.*does not read visibility/);
  });

  it('SAMT: an OK PAYING row on a KPI other than TOTAL / LINES holds the outlet back (KPI + rule in the ops note)', async () => {
    for (const kpi of ['ADHO', 'NON ADHO', 'FOCUS BRAND']) {
      const w = baseWorld();
      w.outlets = [outletRow('S1', { programName: 'SAMT', programCategory: 'Elite' })];
      w.targets = [{ outletCode: 'S1', targetValues: {} }];
      w.monthly = preview([row('S1', kpi, { payoutRupees: 120, ruleId: 'R-SAMT-X', ruleVersion: 1, ruleName: 'SAMT extra' })]);
      expectHeld(await only(w), 'S1', 'SAMT', new RegExp(`${kpi}.*SAMT extra`));
    }
    // An OK row that pays 0 on such a KPI moves no money → no refusal (and no column to show it).
    const w0 = baseWorld();
    w0.outlets = [outletRow('S1', { programName: 'SAMT', programCategory: 'Elite' })];
    w0.targets = [{ outletCode: 'S1', targetValues: {} }];
    w0.monthly = preview([row('S1', 'ADHO', { payoutRupees: 0, ruleId: 'R-SAMT-X', ruleVersion: 1 }), row('S1', 'TOTAL', { payoutRupees: 300, ruleId: 'R-PLAIN', ruleVersion: 2 })]);
    const out = await only(w0);
    expect(out.outlets[0].payout).toEqual({ TOTAL: { amount: 300, reason: null } });
  });

  it('Unnati / Lite: an OK paying row on a KPI the sheet has no column for holds the outlet back (KPI + rule)', async () => {
    for (const sub of ['Unnati', 'Lite']) {
      const w = baseWorld();
      w.outlets = [outletRow('U1', { programCategory: sub })];
      w.monthly = preview([row('U1', 'FOCUS BRAND 2', { payoutRupees: 40, ruleId: 'R-FB2', ruleVersion: 1, ruleName: 'FB2 rule' })]);
      expectHeld(await only(w), 'U1', `Unnati / ${sub}`, /FOCUS BRAND 2.*FB2 rule/);
    }
  });

  it('B3: an Unnati TOTAL row with no rule identity holds the outlet back', async () => {
    const w = baseWorld();
    w.monthly = preview([row('U1', 'TOTAL', { payoutRupees: 300 })]);
    expectHeld(await only(w), 'U1', 'Unnati', /TOTAL.*could not be identified/);
  });

  it('B3: a rule that reads visibility but got no visibility data holds back those outlets (rule named); others still go out', async () => {
    const w = baseWorld();
    w.outlets.push(outletRow('U2'), outletRow('U3'));
    w.targets.push({ outletCode: 'U2', targetValues: {} }, { outletCode: 'U3', targetValues: {} });
    w.monthly = preview([
      row('U1', 'TOTAL', { payoutRupees: 0, ruleId: 'R-VIS', ruleVersion: 1 }),
      row('U2', 'TOTAL', { payoutRupees: 0, ruleId: 'R-VIS', ruleVersion: 1 }),
      row('U3', 'ADHO', { payoutRupees: 90, ruleId: 'R-PLAIN', ruleVersion: 2 }),
    ]);
    const out = await only(w);
    expectHeld(out, 'U1', 'Unnati', /visibility data unavailable.*Unnati visibility/i, 2);
    expectHeld(out, 'U2', 'Unnati', /visibility data unavailable.*Unnati visibility/i, 2);
    expect(out.outlets.map((o) => o.code)).toEqual(['U3']);
    expect(out.outlets[0].payout).toEqual({ ADHO: { amount: 90, reason: null } });
  });

  it('B4: SKIP (not KPI-scope) / NO_RULE rows keep their reason as the part reason (0) + a data note with the codes', async () => {
    const w = baseWorld();
    w.outlets.push(outletRow('W1', { programName: 'BSC', programCategory: 'BSC' }));
    w.targets.push({ outletCode: 'W1', targetValues: { TOTAL: 10 } });
    w.monthly = preview([
      row('U1', 'ADHO', { status: 'NO_RULE', reason: 'No active rule for this attachment.', payoutRupees: undefined }),
      row('U1', 'LINES', { status: 'SKIP', reason: 'No LINES target', payoutRupees: undefined, ruleId: 'R-L', ruleVersion: 1 }),
      row('U1', 'FOCUS BRAND', { status: 'SKIP', reason: 'KPI not applicable', skipKind: 'KPI_SCOPE', payoutRupees: undefined }),
      row('U1', 'TOTAL', { status: 'NO_RULE', payoutRupees: undefined }),
      row('W1', 'TOTAL', { status: 'NO_RULE', payoutRupees: undefined }),
    ]);
    const out = await only(w);
    const by = new Map(out.outlets.map((o) => [o.code, o]));
    expect(by.get('U1')!.payout).toEqual({
      ADHO: { amount: 0, reason: 'No rule for this outlet (check programme / sub-programme)' },
      LINES: { amount: 0, reason: 'No LINES target' },
      VISIBILITY: { amount: 0, reason: 'No rule for this outlet (check programme / sub-programme)' },
    });
    expect(by.get('W1')!.bsc!.base).toEqual({ amount: 0, reason: 'No rule for this outlet (check programme / sub-programme)' });
    const n = notesOf(out, 'ops', ' | ');
    expect(n).toMatch(/no rule.*ADHO.*U1/i);
    expect(n).toMatch(/skipped.*LINES.*U1/i);
    expect(n).not.toMatch(/FOCUS BRAND[^|]*U1/); // KPI-scope skip = expected, not a note
  });

  it('B4: an outlet with targets but NO engine row and no reason → data note', async () => {
    const w = baseWorld();
    w.monthly = preview([]);
    const out = await only(w);
    expect(notesOf(out, 'ops', ' ')).toMatch(/targets but the engine returned no payout.*U1/i);
  });

  it('B5: refuses when the tenant has no points-engine first live month (never risk computing imported months)', async () => {
    const w = baseWorld();
    w.firstLiveMonth = null;
    const { svc, engine } = makeService(w);
    await expect(svc.buildInput('bajaj', '2026-11', NOW)).rejects.toThrow(/first live month is not set/i);
    expect(engine.previewCompute).not.toHaveBeenCalled();
  });

  it('engine switched OFF (preview only) is money-critical → refused, never sent as a note', async () => {
    const w = baseWorld();
    w.monthly = preview([], { engineDisabled: true });
    await expect(only(w)).rejects.toThrow(/points engine is switched OFF/i);
  });

  it('the engine visibility pending summary becomes a data note', async () => {
    const w = baseWorld();
    w.monthly = preview([], {
      visibility: {
        month: '2026-11', mode: 'PHOTO_APPROVAL', available: true, windows: 2, openWindowsInMonth: 1, outletsApproved: 10,
        outletsWithData: 40, outletsWaitingReview: 3, outletsOpenWindow: 5, outletsPending: 7, countedOutsideDatedScope: 0,
        excluded: { olderFrequency: 0, notInProgramme: 0 } as never, waitingOutletCodes: [], openOutletCodes: [], pendingKey: 'k',
      },
    });
    const out = await only(w);
    expect(notesOf(out, 'client', ' ')).toMatch(/7 outlet\(s\).*3 waiting for review.*5 with an open window/);
  });

  it('BSC mapping: TOTAL → base, FOCUS BRAND → fb1, FOCUS BRAND 2 → fb2 (points); missing part = 0 no reason', async () => {
    const w = baseWorld();
    w.outlets.push(outletRow('W1', { programName: 'BSC', programCategory: 'BSC', outletType: { code: 'WHOLESALER', name: 'Wholesaler' } }), outletRow('W2', { programName: 'BSC', programCategory: 'BSC' }));
    w.targets.push({ outletCode: 'W1', targetValues: {} }, { outletCode: 'W2', targetValues: {} });
    w.monthly = preview([
      row('W1', 'TOTAL', { awardType: 'POINTS', points: 665, payoutRupees: undefined }),
      row('W1', 'FOCUS BRAND', { awardType: 'POINTS', points: 0, payoutRupees: undefined, reason: 'FB1 below target' }),
      row('W1', 'FOCUS BRAND 2', { awardType: 'POINTS', points: 25, payoutRupees: undefined }),
      row('W2', 'TOTAL', { awardType: 'POINTS', points: 0, payoutRupees: undefined, reason: 'TOTAL below target' }),
    ]);
    const out = await only(w);
    const by = new Map(out.outlets.map((o) => [o.code, o]));
    expect(by.get('W1')!.bsc).toEqual({
      base: { amount: 665, reason: null },
      fb1: { amount: 0, reason: 'FB1 below target' },
      fb2: { amount: 25, reason: null },
    });
    expect(by.get('W1')!.payout).toBeUndefined();
    expect(by.get('W2')!.bsc).toEqual({
      base: { amount: 0, reason: 'TOTAL below target' },
      fb1: { amount: 0, reason: null },
      fb2: { amount: 0, reason: null },
    });
  });

  it('an ERROR engine row holds ONLY that outlet back (exact error text + KPI + rule for ops); the rest of the report goes out', async () => {
    const w = baseWorld();
    w.outlets.push(outletRow('W1', { programName: 'BSC', programCategory: 'BSC' }), outletRow('U2'));
    w.targets.push({ outletCode: 'W1', targetValues: {} }, { outletCode: 'U2', targetValues: {} });
    w.monthly = preview([
      row('U1', 'ADHO', { status: 'ERROR', reason: 'Invalid rule: x', payoutRupees: undefined, ruleId: 'R-A', ruleVersion: 3, ruleName: 'Unnati ADHO' }),
      row('U1', 'LINES', { status: 'ERROR', reason: 'Credit field "Lines" is inactive', payoutRupees: undefined }),
      row('U1', 'NON ADHO', { payoutRupees: 70 }),
      row('W1', 'TOTAL', { status: 'ERROR', reason: 'boom', payoutRupees: undefined }),
      row('U2', 'ADHO', { payoutRupees: 55 }),
    ]);
    const out = await only(w);
    expectHeld(out, 'U1', 'Unnati', /ADHO \(rule Unnati ADHO\): Invalid rule: x/, 2);
    expectHeld(out, 'U1', 'Unnati', /LINES.*Credit field "Lines" is inactive/, 2);
    expectHeld(out, 'W1', 'BSC', /TOTAL.*boom/, 2);
    expect(out.outlets.map((o) => o.code)).toEqual(['U2']);
    expect(out.outlets[0].payout).toEqual({ ADHO: { amount: 55, reason: null } });
    // A held outlet is not repeated in other housekeeping notes (it is not on the report at all).
    const otherOps = out.notes.filter((n) => n.audience === 'ops' && !n.text.startsWith('Held back:')).map((n) => n.text).join(' ');
    expect(otherOps).not.toMatch(/\bU1\b|\bW1\b/);
  });

  it('no held-back outlets → no hold-back notes', async () => {
    const w = baseWorld();
    w.monthly = preview([row('U1', 'ADHO', { payoutRupees: 10 })]);
    const out = await only(w);
    expect(out.notes.map((n) => n.text).join(' ')).not.toMatch(/held back/i);
  });

  it('an award type that does not fit the programme (POINTS on Unnati / PAYOUT on BSC) holds the outlet back', async () => {
    const w = baseWorld();
    w.outlets.push(outletRow('W1', { programName: 'BSC', programCategory: 'BSC' }));
    w.targets.push({ outletCode: 'W1', targetValues: {} });
    w.monthly = preview([
      row('U1', 'ADHO', { awardType: 'POINTS', points: 10, payoutRupees: undefined }),
      row('W1', 'TOTAL', { awardType: 'PAYOUT', payoutRupees: 10 }),
    ]);
    const out = await only(w);
    expectHeld(out, 'U1', 'Unnati', /ADHO.*pays POINTS.*must be PAYOUT/, 2);
    expectHeld(out, 'W1', 'BSC', /TOTAL.*pays PAYOUT.*must be POINTS/, 2);
  });

  it('an OK row for an unexpected KPI code holds the outlet back (money never dropped silently)', async () => {
    const w = baseWorld();
    w.monthly = preview([row('U1', 'MYSTERY', { payoutRupees: 50 })]);
    expectHeld(await only(w), 'U1', 'Unnati', /MYSTERY/);
  });

  it('engine rows for outlets outside the month universe are ignored', async () => {
    const w = baseWorld();
    w.monthly = preview([row('ZZ', 'ADHO', { status: 'ERROR', reason: 'bad' }), row('ZZ', 'ADHO', { payoutRupees: 10 })]);
    const out = await only(w);
    expect(out.outlets.map((o) => o.code)).toEqual(['U1']);
  });

  it('calls the read-only previewCompute for the month, all programmes, as the tenant', async () => {
    const { svc, engine } = makeService(baseWorld());
    await svc.buildInput('bajaj', '2026-11', NOW);
    expect(engine.previewCompute).toHaveBeenCalledTimes(1);
    const [user, opts] = engine.previewCompute.mock.calls[0];
    expect(user.clientId).toBe('bajaj');
    expect(opts).toEqual({ period: '2026-11' });
  });

  it('refuses imported months (before first-live) WITHOUT computing', async () => {
    const w = baseWorld();
    const { svc, engine } = makeService(w);
    await expect(svc.buildInput('bajaj', '2026-10', NOW)).rejects.toThrow(/imported/i);
    expect(engine.previewCompute).not.toHaveBeenCalled();
  });

  it('refuses when the engine itself flags the month as imported', async () => {
    const w = baseWorld();
    w.monthly = preview([], { importedMonths: { firstLiveMonth: '2026-12', months: ['2026-11'], monthLabels: ['Nov 2026'], confirmKey: '' } });
    await expect(only(w)).rejects.toThrow(/imported/i);
  });

  it('refuses a malformed or future month', async () => {
    const { svc } = makeService(baseWorld());
    await expect(svc.buildInput('bajaj', '2026-13', NOW)).rejects.toThrow(/YYYY-MM/);
    await expect(svc.buildInput('bajaj', '2026-12', NOW)).rejects.toThrow(/future/i);
  });

  it('provisional: OPEN or missing month status → true; CLOSED → false', async () => {
    const w = baseWorld();
    w.monthStatus = { state: 'CLOSED' };
    expect((await only(w)).provisional).toBe(false);
    w.monthStatus = null;
    expect((await only(w)).provisional).toBe(true);
  });

  it('salesAsOf: no day set → "data applied <IST date>" from lastAppliedAt, else latest record update; nothing → "—"', async () => {
    const w = baseWorld();
    w.daySet = null;
    w.monthStatus = { state: 'OPEN', lastAppliedAt: new Date('2026-11-25T19:00:00.000Z') }; // 26 Nov 00:30 IST
    expect((await only(w)).salesAsOf).toBe('data applied 26 Nov 2026');
    w.monthStatus = { state: 'OPEN', lastAppliedAt: null };
    expect((await only(w)).salesAsOf).toBe('data applied 27 Nov 2026'); // 26 Nov 20:00 UTC = 27 Nov IST
    w.sales = [];
    expect((await only(w)).salesAsOf).toBe('—');
  });

  it('ownerName: ChannelPartner.ownerName first, Outlet.ownerName fallback, else null; beat never back-filled', async () => {
    const w = baseWorld();
    w.outlets = [
      outletRow('U1'),
      outletRow('N1', { partner: null }),
      outletRow('N2', { partner: { ownerName: '  ' }, ownerName: null, beat: null }),
    ];
    w.targets.push({ outletCode: 'N1', targetValues: {} }, { outletCode: 'N2', targetValues: {} });
    const out = await only(w);
    const by = new Map(out.outlets.map((o) => [o.code, o]));
    expect(by.get('U1')!.ownerName).toBe('Partner U1');
    expect(by.get('N1')!.ownerName).toBe('Owner N1');
    expect(by.get('N2')!.ownerName).toBeNull();
    expect(by.get('N2')!.beat).toBeNull();
  });

  it('client name falls back to internalName then id', async () => {
    const w = baseWorld();
    w.client = { id: 'bajaj', internalName: 'Bajaj CC', branding: {} };
    expect((await only(w)).clientName).toBe('Bajaj CC');
    w.client = null;
    expect((await only(w)).clientName).toBe('bajaj');
  });

  describe('quarter-end month (December)', () => {
    const decWorld = () => {
      const w = baseWorld();
      w.firstLiveMonth = '2026-10';
      w.outlets.push(outletRow('W1', { programName: 'BSC', programCategory: 'BSC' }), outletRow('W2', { programName: 'BSC', programCategory: 'BSC' }));
      w.targets.push({ outletCode: 'W1', targetValues: {} }, { outletCode: 'W2', targetValues: {} });
      w.monthly = preview([], { period: '2026-12' });
      w.quarterly = preview(
        [
          row('W1', 'BSC CASES', { awardType: 'POINTS', points: 95, payoutRupees: undefined }),
          row('W2', 'BSC CASES', { awardType: 'POINTS', points: 0, payoutRupees: undefined, reason: 'missed Nov' }),
          row('U1', 'BSC CASES', { status: 'SKIP', payoutRupees: undefined }),
        ],
        { period: '2026-Q3' },
      );
      return w;
    };

    it('consistencyBonus from the engine QUARTER preview for BSC outlets; null for others', async () => {
      const { svc, engine } = makeService(decWorld());
      const out = await svc.buildInput('bajaj', '2026-12', new Date('2026-12-15T00:00:00Z'));
      expect(out).toMatchObject({ isQuarterEnd: true, quarterLabel: 'Oct–Dec 2026', bonusPaidIn: 'December 2026', monthLabel: 'December 2026' });
      const by = new Map(out.outlets.map((o) => [o.code, o]));
      expect(by.get('W1')!.consistencyBonus).toBe(95);
      expect(by.get('W2')!.consistencyBonus).toBe(0);
      expect(by.get('U1')!.consistencyBonus).toBeNull();
      expect(by.get('W1')!.bonusStatus).toBe('computed');
      expect(by.get('U1')!.bonusStatus).toBe('not-applicable');
      expect(out.bonusNote).toBeUndefined();
      expect(engine.previewCompute.mock.calls.map((c: [unknown, { period: string }]) => c[1].period)).toEqual(['2026-12', '2026-Q3']);
    });

    it('no quarterly rule → bonus null + a note', async () => {
      const w = decWorld();
      w.quarterly = preview([], { period: '2026-Q3', emptyReason: 'No quarterly rule' });
      const out = await only(w, '2026-12', new Date('2026-12-15T00:00:00Z'));
      expect(out.outlets.find((o) => o.code === 'W1')!.consistencyBonus).toBeNull();
      expect(out.outlets.find((o) => o.code === 'W1')!.bonusStatus).toBe('not-computed');
      expect(out.bonusNote).toMatch(/No quarterly rule/);
      expect(notesOf(out, 'client', ' ')).toMatch(/No quarterly rule/);
    });

    it('a quarter that includes an imported month is NOT computed (bonus null + note)', async () => {
      const w = decWorld();
      w.firstLiveMonth = '2026-11';
      const { svc, engine } = makeService(w);
      const out = await svc.buildInput('bajaj', '2026-12', new Date('2026-12-15T00:00:00Z'));
      expect(engine.previewCompute).toHaveBeenCalledTimes(1);
      expect(out.outlets.find((o) => o.code === 'W1')!.consistencyBonus).toBeNull();
      expect(out.outlets.find((o) => o.code === 'W1')!.bonusStatus).toBe('not-computed');
      expect(out.bonusNote).toBe('October 2026 was imported from the old system');
      expect(notesOf(out, 'client', ' ')).toMatch(/imported/i);
    });

    it('per BSC outlet: OK rows → computed (sum; a genuine 0 keeps its reason); NO_RULE / SKIP / missing → not-computed + reason + ops note', async () => {
      const w = decWorld();
      w.outlets.push(
        outletRow('W3', { programName: 'BSC', programCategory: 'BSC' }),
        outletRow('W4', { programName: 'BSC', programCategory: 'BSC' }),
        outletRow('W5', { programName: 'BSC', programCategory: 'BSC' }),
        outletRow('W6', { programName: 'BSC', programCategory: 'BSC' }),
      );
      w.targets.push(...['W3', 'W4', 'W5', 'W6'].map((c) => ({ outletCode: c, targetValues: {} })));
      w.quarterly!.rows.push(
        row('W1', 'FOCUS BRAND', { awardType: 'POINTS', points: 5, payoutRupees: undefined }), // second OK row → summed
        row('W3', 'BSC CASES', { status: 'NO_RULE', payoutRupees: undefined }),
        row('W4', 'BSC CASES', { status: 'SKIP', reason: 'No BSC CASES in Oct', payoutRupees: undefined }),
        row('W6', 'BSC CASES', { status: 'SKIP', skipKind: 'KPI_SCOPE', reason: 'not in scope', payoutRupees: undefined }),
        // W5: no quarterly row at all
      );
      const out = await only(w, '2026-12', new Date('2026-12-15T00:00:00Z'));
      const by = new Map(out.outlets.map((o) => [o.code, o]));
      expect(by.get('W1')).toMatchObject({ consistencyBonus: 100, bonusStatus: 'computed' });
      expect(by.get('W2')).toMatchObject({ consistencyBonus: 0, bonusStatus: 'computed', bonusReason: 'missed Nov' });
      expect(by.get('W3')).toMatchObject({ consistencyBonus: null, bonusStatus: 'not-computed', bonusReason: 'no quarterly rule for this outlet' });
      expect(by.get('W4')).toMatchObject({ consistencyBonus: null, bonusStatus: 'not-computed', bonusReason: 'No BSC CASES in Oct' });
      expect(by.get('W5')).toMatchObject({ consistencyBonus: null, bonusStatus: 'not-computed', bonusReason: 'no quarterly result for this outlet' });
      expect(by.get('W6')).toMatchObject({ consistencyBonus: null, bonusStatus: 'not-applicable' });
      expect(notesOf(out, 'ops', ' ')).toMatch(/Consistency bonus.*not computed for 3 BSC outlet\(s\): W3, W4, W5/);
    });

    it('the quarterly preview with the engine OFF fails the run (like the monthly one)', async () => {
      const w = decWorld();
      w.quarterly = { ...w.quarterly!, engineDisabled: true };
      await expect(only(w, '2026-12', new Date('2026-12-15T00:00:00Z'))).rejects.toThrow(/points engine is switched OFF/i);
    });

    it('an ERROR row in the quarter preview holds that outlet back (quarter named); W2 still computed', async () => {
      const w = decWorld();
      w.quarterly!.rows.push(row('W1', 'BSC CASES', { status: 'ERROR', reason: 'conflict' }));
      const out = await only(w, '2026-12', new Date('2026-12-15T00:00:00Z'));
      expectHeld(out, 'W1', 'BSC', /Oct–Dec 2026.*BSC CASES.*conflict/);
      expect(out.outlets.find((o) => o.code === 'W2')).toMatchObject({ consistencyBonus: 0, bonusStatus: 'computed' });
    });
  });

  it('uses one query per entity type regardless of outlet count', async () => {
    const w = baseWorld();
    for (let i = 0; i < 300; i++) {
      w.outlets.push(outletRow(`X${i}`));
      w.targets.push({ outletCode: `X${i}`, targetValues: { TOTAL: 1 } });
    }
    const { svc, prisma } = makeService(w);
    const out = await svc.buildInput('bajaj', '2026-11', NOW);
    expect(out.outlets).toHaveLength(301);
    for (const m of ['outletTarget', 'outlet', 'salesUserAssignment', 'salesUser', 'kycSubmission', 'visibilityCapture'] as const) {
      expect(prisma[m].findMany).toHaveBeenCalledTimes(1);
    }
    expect(prisma.outletSalesRecord.findMany).toHaveBeenCalledTimes(2);
  });
});
