import { buildRows } from './payout-tracker.rows';
import { ChainLink, OutletInput, RETAIL_COLUMNS, TrackerInput, wsColumns } from './payout-tracker.types';

const chain = (over: Partial<Record<'XSR' | 'SO' | 'ASM' | 'RSM', Partial<ChainLink> | null>> = {}): ChainLink[] => {
  const base: Record<string, ChainLink> = {
    XSR: { level: 'XSR', hq: 'ISRHQ', name: 'Isr One', active: true },
    SO: { level: 'SO', hq: 'SOHQ', name: 'So One', active: true },
    ASM: { level: 'ASM', hq: 'ASMHQ', name: 'Asm One', active: true },
    RSM: { level: 'RSM', hq: 'SMHQ', name: 'Sm One', active: true },
  };
  const out: ChainLink[] = [];
  for (const lvl of ['XSR', 'SO', 'ASM', 'RSM'] as const) {
    const o = over[lvl];
    if (o === null) continue;
    out.push({ ...base[lvl], ...(o ?? {}) });
  }
  return out;
};

const outlet = (over: Partial<OutletInput> = {}): OutletInput => ({
  code: 'C1',
  name: 'Shop One',
  ownerName: 'Owner',
  zone: 'North',
  state: 'Delhi',
  town: 'Delhi',
  beat: 'Beat A',
  metro: 'Metro',
  sapCode: 'SAP1',
  dbName: 'Dist One',
  program: 'Unnati',
  subProgram: 'Unnati',
  outletTypeCode: 'SSS_TOT',
  outletTypeLabel: 'SSS TOT',
  gifsyApproved: true,
  visibility: 'APPROVED',
  chain: chain(),
  targets: { TOTAL: 1000, ADHO: 500, 'NON ADHO': 300, 'FOCUS BRAND': 200, LINES: 10 },
  achievements: { TOTAL: 1100, ADHO: 500, 'NON ADHO': 150, 'FOCUS BRAND': 300, LINES: 12 },
  lastMonthTotal: 900,
  payout: {
    ADHO: { amount: 100, reason: null },
    'NON ADHO': { amount: 0, reason: 'Below 80%' },
    'FOCUS BRAND': { amount: 50, reason: null },
    VISIBILITY: { amount: 500, reason: null },
    LINES: { amount: 40, reason: null },
  },
  ...over,
});

const input = (outlets: OutletInput[], over: Partial<TrackerInput> = {}): TrackerInput => ({
  clientName: 'Bajaj Consumer Care',
  month: '2026-11',
  monthLabel: 'November 2026',
  salesAsOf: '27 Nov 2026',
  provisional: true,
  quarterLabel: 'Oct–Dec 2026',
  bonusPaidIn: 'December 2026',
  isQuarterEnd: false,
  outlets,
  notes: [],
  ...over,
});

const retail1 = (o: Partial<OutletInput>) => {
  const r = buildRows(input([outlet(o)]));
  expect(r.retail).toHaveLength(1);
  return r.retail[0];
};

const bscOutlet = (over: Partial<OutletInput> = {}): OutletInput =>
  outlet({
    code: 'W1',
    program: 'BSC',
    subProgram: 'BSC',
    outletTypeCode: 'WHOLESALER',
    outletTypeLabel: 'Wholesaler',
    payout: undefined,
    targets: { TOTAL: 10000 },
    achievements: { TOTAL: 12000, 'BSC CASES': 12.5, 'FB1 CASES': 3.25, 'FB2 CASES': 0 },
    bsc: { base: { amount: 120, reason: null }, fb1: { amount: 30, reason: null }, fb2: { amount: 0, reason: 'No FB2 cases' } },
    consistencyBonus: 75,
    ...over,
  });

describe('buildRows — routing', () => {
  it('routes Unnati/SAMT to retail, BSC to ws (case-insensitive, trimmed)', () => {
    const r = buildRows(
      input([
        outlet({ code: 'A', program: ' unnati ' }),
        outlet({ code: 'B', program: 'SAMT', subProgram: 'Elite' }),
        bscOutlet({ code: 'C', program: 'bsc ' }),
      ]),
    );
    expect(r.retail.map((x) => x.cells['Customer Code'])).toEqual(['A', 'B']);
    expect(r.ws.map((x) => x.cells.CODE)).toEqual(['C']);
    expect(r.exceptions).toEqual([]);
  });

  it('unknown or null programme → exception with clear reason, never dropped', () => {
    const r = buildRows(
      input([outlet({ code: 'X', name: 'Ex', program: 'Mystery', subProgram: 'Foo' }), outlet({ code: 'Y', name: 'Why', program: null, subProgram: null })]),
    );
    expect(r.retail).toHaveLength(0);
    expect(r.ws).toHaveLength(0);
    expect(r.exceptions).toEqual([
      { code: 'X', name: 'Ex', reason: 'Unknown programme "Mystery" / sub-programme "Foo"' },
      { code: 'Y', name: 'Why', reason: 'Unknown programme "(none)" / sub-programme "(none)"' },
    ]);
  });

  it('RLP outlet with no payout object → retail row with 0 amounts, not an exception', () => {
    const r = buildRows(input([outlet({ payout: undefined })]));
    expect(r.exceptions).toHaveLength(0);
    const c = r.retail[0].cells;
    expect(c['Performance Payout']).toBe(0);
    expect(c['Visibility Payout']).toBe(0);
    expect(c['Line Payout']).toBe(0);
    expect(c['Total Payout']).toBe(0);
    expect(c.Reason).toBe('');
    expect(c['Gifsy Approval']).toBe(0);
  });

  it('empty input → empty sheets', () => {
    expect(buildRows(input([]))).toEqual({ retail: [], ws: [], exceptions: [] });
  });
});

describe('buildRows — every column present', () => {
  it('retail rows contain every RETAIL_COLUMNS key and nothing else', () => {
    for (const o of [outlet(), outlet({ program: 'SAMT', subProgram: 'Elite' }), outlet({ payout: undefined, chain: [], targets: {}, achievements: {} })]) {
      const keys = Object.keys(retail1(o).cells).sort();
      expect(keys).toEqual([...RETAIL_COLUMNS].sort());
    }
  });

  it('ws rows contain every wsColumns(quarterLabel) key and nothing else', () => {
    const r = buildRows(input([bscOutlet(), bscOutlet({ code: 'W2', bsc: undefined, chain: [], targets: {}, achievements: {} })]));
    for (const row of r.ws) expect(Object.keys(row.cells).sort()).toEqual(wsColumns('Oct–Dec 2026').sort());
  });
});

describe('buildRows — chain', () => {
  it('maps levels to HQ / name columns and meta', () => {
    const row = retail1({});
    expect(row.cells).toMatchObject({
      'SM HQ': 'SMHQ', 'ASM HQ': 'ASMHQ', 'SO HQ': 'SOHQ',
      'SM Name': 'Sm One', ASM: 'Asm One', SO: 'So One', 'ISR Name': 'Isr One',
    });
    expect(row.meta).toMatchObject({ smKey: 'SMHQ', smLabel: 'SMHQ — Sm One', asmHq: 'ASMHQ', zone: 'North' });
  });

  it('finds links by level, not position', () => {
    const c = chain().reverse();
    expect(retail1({ chain: c }).cells['ISR Name']).toBe('Isr One');
  });

  it('inactive SM → Vacant name but HQ kept; smLabel uses Vacant', () => {
    const row = retail1({ chain: chain({ RSM: { active: false } }) });
    expect(row.cells['SM Name']).toBe('Vacant');
    expect(row.cells['SM HQ']).toBe('SMHQ');
    expect(row.meta.smLabel).toBe('SMHQ — Vacant');
  });

  it('blank / null name → Vacant', () => {
    const row = retail1({ chain: chain({ SO: { name: '  ' }, ASM: { name: null } }) });
    expect(row.cells.SO).toBe('Vacant');
    expect(row.cells.ASM).toBe('Vacant');
  });

  it('missing chain → Vacant names, blank HQs, (no SM)/(no ASM) meta', () => {
    const row = retail1({ chain: [], zone: null });
    expect(row.cells).toMatchObject({
      'SM HQ': '', 'ASM HQ': '', 'SO HQ': '', 'SM Name': 'Vacant', ASM: 'Vacant', SO: 'Vacant', 'ISR Name': 'Vacant', Zone: '',
    });
    expect(row.meta).toMatchObject({ smKey: '(no SM)', smLabel: '(no SM)', asmHq: '(no ASM)', zone: '(no zone)' });
  });

  it('missing SM only → (no SM), ASM still present', () => {
    const row = retail1({ chain: chain({ RSM: null }) });
    expect(row.meta.smKey).toBe('(no SM)');
    expect(row.meta.asmHq).toBe('ASMHQ');
  });
});

describe('buildRows — retail descriptive cells', () => {
  it('strings default to empty string when null', () => {
    const c = retail1({ zone: null, state: null, town: null, beat: null, sapCode: null, dbName: null, metro: null }).cells;
    expect([c.Zone, c.State, c.TOWN, c['Beat Name'], c['SAP Code'], c['DB Name'], c['POP STRATA']]).toEqual(['', '', '', '', '', '', '']);
  });

  it.each([
    ['Yes', 'Metro'], ['No', 'Non Metro'], ['Metro', 'Metro'], ['Non Metro', 'Non Metro'], ['Rural', ''], [null, ''],
  ])('POP STRATA %p → %p', (metro, expected) => {
    expect(retail1({ metro }).cells['POP STRATA']).toBe(expected);
  });

  it.each([
    ['Unnati', 'Unnati', 'Unnati', 'Grocers'],
    ['Unnati', 'Lite', 'Unnati Lite', 'Grocers'],
    ['SAMT', 'Elite', 'SAMT Elite', 'SAMT'],
    ['SAMT', 'Privilege', 'SAMT Privilege', 'SAMT'],
    ['Unnati', 'Odd', 'Odd', 'Grocers'],
  ])('%s/%s → Sub-Program %p, SUB CHANNEL %p', (program, subProgram, label, channel) => {
    const c = retail1({ program, subProgram }).cells;
    expect(c.Program).toBe(program);
    expect(c['Sub- Program']).toBe(label);
    expect(c['SUB CHANNEL']).toBe(channel);
  });

  it('Outlet Type = label ?? code ?? ""', () => {
    expect(retail1({}).cells['Outlet Type']).toBe('SSS TOT');
    expect(retail1({ outletTypeLabel: null }).cells['Outlet Type']).toBe('SSS_TOT');
    expect(retail1({ outletTypeLabel: null, outletTypeCode: null }).cells['Outlet Type']).toBe('');
  });

  it('codes / names / town / beat copied', () => {
    const c = retail1({}).cells;
    expect(c).toMatchObject({ 'Customer Code': 'C1', 'Customer Name': 'Shop One', TOWN: 'Delhi', 'Beat Name': 'Beat A', 'SAP Code': 'SAP1', 'DB Name': 'Dist One' });
  });
});

describe('buildRows — targets and ratios', () => {
  it('base fixture ratios', () => {
    const c = retail1({}).cells;
    expect(c['Total Target']).toBe(1000);
    expect(c['Total Ach']).toBe(1100);
    expect(c['Total Ach %']).toBeCloseTo(1.1);
    expect(c['ADHO Ach %']).toBe(1); // exactly 100%
    expect(c['Non ADHO Ach %']).toBeCloseTo(0.5);
    expect(c['FB Ach %']).toBe(1.2); // 150% capped
    expect(c['Line Ach %']).toBeCloseTo(1.2);
  });

  it('>120% ADHO is capped at 1.2, Total & Line uncapped', () => {
    const c = retail1({
      targets: { TOTAL: 100, ADHO: 100, LINES: 5 },
      achievements: { TOTAL: 300, ADHO: 250, LINES: 15 },
    }).cells;
    expect(c['ADHO Ach %']).toBe(1.2);
    expect(c['Total Ach %']).toBe(3);
    expect(c['Line Ach %']).toBe(3);
  });

  it('negative achievement kept (not floored)', () => {
    const c = retail1({ achievements: { TOTAL: -50, ADHO: -100, 'NON ADHO': 0, 'FOCUS BRAND': 0, LINES: 0 } }).cells;
    expect(c['ADHO Ach %']).toBe(-0.2);
    expect(c['Total Ach %']).toBe(-0.05);
    expect(c.ECO).toBe(0);
    expect(c.WOA).toBe(0);
  });

  it('zero / missing target → null %; missing KPI → null cells', () => {
    const c = retail1({ targets: { TOTAL: 0, ADHO: 0 }, achievements: { TOTAL: 10 } }).cells;
    expect(c['Total Ach %']).toBeNull();
    expect(c['ADHO Ach %']).toBeNull();
    expect(c['Non ADHO Target']).toBeNull();
    expect(c['Non ADHO Ach']).toBeNull();
    expect(c['Non ADHO Ach %']).toBeNull();
    expect(c['Line Ach %']).toBeNull();
    expect(c.WOA).toBe(0);
    expect(c.ECO).toBe(1);
  });

  it('null achievement with a target counts as 0', () => {
    const c = retail1({ targets: { ADHO: 100 }, achievements: { ADHO: null } }).cells;
    expect(c['ADHO Ach']).toBeNull();
    expect(c['ADHO Ach %']).toBe(0);
    expect(c.ECO).toBe(0);
  });

  it('WOA exactly at target = 1, just below = 0', () => {
    expect(retail1({ achievements: { TOTAL: 1000 } }).cells.WOA).toBe(1);
    expect(retail1({ achievements: { TOTAL: 999.99 } }).cells.WOA).toBe(0);
  });

  it('SAMT → FB cells NA', () => {
    const c = retail1({ program: 'SAMT', subProgram: 'Privilege' }).cells;
    expect(c['FB Target']).toBe('NA');
    expect(c['FB Ach']).toBe('NA');
    expect(c['FB Ach %']).toBe('NA');
    expect(c['ADHO Ach %']).toBe(1);
  });
});

describe('buildRows — visibility', () => {
  it('Unnati Metro approved → 500 window/potential', () => {
    const c = retail1({ metro: 'Metro' }).cells;
    expect(c['Payout per Window']).toBe(500);
    expect(c['Potential Payout']).toBe(500);
  });

  it('Unnati Non Metro approved → 250; "No" metro too', () => {
    expect(retail1({ metro: 'Non Metro' }).cells['Payout per Window']).toBe(250);
    expect(retail1({ metro: 'No' }).cells['Potential Payout']).toBe(250);
    expect(retail1({ metro: 'Yes' }).cells['Potential Payout']).toBe(500);
  });

  it('Unnati unknown strata or not approved → 0', () => {
    expect(retail1({ metro: null }).cells['Payout per Window']).toBe(0);
    expect(retail1({ visibility: 'SUBMITTED' }).cells['Payout per Window']).toBe(0);
  });

  it('Lite → window 0 even when approved Metro; visibility payout from engine (0 when absent)', () => {
    const c = retail1({ subProgram: 'Lite', payout: { ADHO: { amount: 20, reason: null } } }).cells;
    expect(c['Payout per Window']).toBe(0);
    expect(c['Potential Payout']).toBe(0);
    expect(c['Visibility Payout']).toBe(0);
    expect(c['Total Payout']).toBe(20);
  });

  it('SAMT → window/potential/visibility payout NA', () => {
    const c = retail1({ program: 'SAMT', subProgram: 'Elite' }).cells;
    expect(c['Payout per Window']).toBe('NA');
    expect(c['Potential Payout']).toBe('NA');
    expect(c['Visibility Payout']).toBe('NA');
  });

  it.each([
    [null, 'Visibility not Executed', 0, 0],
    ['APPROVED', 'Approved', 1, 1],
    ['SUBMITTED', 'Pending review', 1, 0],
    ['REJECTED', 'Rejected', 1, 0],
    ['CHANGES_REQUESTED', 'Rejected', 1, 0],
  ] as const)('status %p → %p, WORKING %p, Approved %p', (visibility, label, working, approved) => {
    const c = retail1({ visibility }).cells;
    expect(c['Visibility Status']).toBe(label);
    expect(c.WORKING).toBe(working);
    expect(c['Approved Visibility Payout']).toBe(approved);
  });
});

describe('buildRows — payouts', () => {
  it('Unnati: Performance = ADHO + NON ADHO + FB; Total = perf + vis + line', () => {
    const c = retail1({}).cells;
    expect(c['Performance Payout']).toBe(150);
    expect(c['Visibility Payout']).toBe(500);
    expect(c['Line Payout']).toBe(40);
    expect(c['Total Payout']).toBe(690);
    expect(c.Reason).toBe('Below 80%');
    expect(c['Gifsy Approval']).toBe(1);
  });

  it('SAMT Elite: Performance = TOTAL part, visibility not summed', () => {
    const c = retail1({
      program: 'SAMT',
      subProgram: 'Elite',
      payout: {
        TOTAL: { amount: 800, reason: null },
        ADHO: { amount: 999, reason: null },
        VISIBILITY: { amount: 500, reason: null },
        LINES: { amount: 60, reason: null },
      },
    }).cells;
    expect(c['Performance Payout']).toBe(800);
    expect(c['Total Payout']).toBe(860);
  });

  it('SAMT Privilege with missing TOTAL part → 0 and Gifsy Approval 0', () => {
    const c = retail1({ program: 'SAMT', subProgram: 'Privilege', payout: { TOTAL: { amount: 0, reason: 'Below slab' } } }).cells;
    expect(c['Performance Payout']).toBe(0);
    expect(c['Total Payout']).toBe(0);
    expect(c.Reason).toBe('Below slab');
    expect(c['Gifsy Approval']).toBe(0);
  });

  it('reasons: only zero-amount parts, distinct, non-empty, joined "; "', () => {
    const c = retail1({
      payout: {
        ADHO: { amount: 0, reason: 'Below 80%' },
        'NON ADHO': { amount: 0, reason: 'Below 80%' },
        'FOCUS BRAND': { amount: 0, reason: 'FB not met' },
        VISIBILITY: { amount: 0, reason: '' },
        LINES: { amount: 30, reason: 'ignored because paid' },
      },
    }).cells;
    expect(c.Reason).toBe('Below 80%; FB not met');
    expect(c['Total Payout']).toBe(30);
  });
});

describe('buildRows — meta', () => {
  it('approved + lastMonthTotal carried', () => {
    const r = retail1({ gifsyApproved: false, lastMonthTotal: null });
    expect(r.meta.approved).toBe(false);
    expect(r.meta.lastMonthTotal).toBeNull();
  });
});

describe('buildRows — WS (BSC)', () => {
  it('lays out a BSC row, not quarter-end', () => {
    const r = buildRows(input([bscOutlet()]));
    const row = r.ws[0];
    const c = row.cells;
    expect(c).toMatchObject({
      Zone: 'North', State: 'Delhi', 'SM HQ': 'SMHQ', 'ASM HQ': 'ASMHQ', 'SO HQ': 'SOHQ',
      'SM Name': 'Sm One', ASM: 'Asm One', SO: 'So One', 'SAP Code': 'SAP1', 'DB Name': 'Dist One',
      CODE: 'W1', 'Customer Name': 'Shop One', 'WH Name': 'Owner',
      Target: 10000, Ach: 12000, 'Ach WOA': 1,
      'Total Cases': 12.5, 'FB1 Cases': 3.25, 'FB2 Cases': 0,
      'Base Points': 120, 'FB1 Points': 30, 'FB2 Points': 0, 'Total Points': 150,
      Reason: 'No FB2 cases',
      'Consistency Bonus (Oct–Dec 2026)': '— (paid in December 2026)',
      'Final Points': 150,
      'Gifsy Approval': 1,
    });
    expect(c['Ach%']).toBeCloseTo(1.2);
    expect(row.meta).toEqual({ approved: true, lastMonthTotal: 900, smKey: 'SMHQ', smLabel: 'SMHQ — Sm One', zone: 'North', totalAch: 12000 });
  });

  it('quarter-end adds consistency bonus to Final Points', () => {
    const c = buildRows(input([bscOutlet()], { isQuarterEnd: true })).ws[0].cells;
    expect(c['Consistency Bonus (Oct–Dec 2026)']).toBe(75);
    expect(c['Final Points']).toBe(225);
  });

  it('quarter-end with a computed 0 bonus → 0', () => {
    const c = buildRows(input([bscOutlet({ consistencyBonus: 0, bonusStatus: 'computed' })], { isQuarterEnd: true })).ws[0].cells;
    expect(c['Consistency Bonus (Oct–Dec 2026)']).toBe(0);
    expect(c['Final Points']).toBe(150);
  });

  it('quarter-end, bonus NOT computed → "— (not computed: <reason>)", Final = Total, never 0', () => {
    const c = buildRows(
      input([bscOutlet({ consistencyBonus: null, bonusStatus: 'not-computed' })], {
        isQuarterEnd: true,
        bonusNote: 'October 2026 was imported from the old system',
      }),
    ).ws[0].cells;
    expect(c['Consistency Bonus (Oct–Dec 2026)']).toBe('— (not computed: October 2026 was imported from the old system)');
    expect(c['Final Points']).toBe(150);
    // A stray number with not-computed is still never added.
    const c2 = buildRows(input([bscOutlet({ consistencyBonus: 75, bonusStatus: 'not-computed' })], { isQuarterEnd: true })).ws[0].cells;
    expect(c2['Consistency Bonus (Oct–Dec 2026)']).toBe('— (not computed: reason not given)');
    expect(c2['Final Points']).toBe(150);
  });

  it('quarter-end, per-outlet not-computed reason overrides the tenant bonusNote', () => {
    const c = buildRows(
      input([bscOutlet({ consistencyBonus: null, bonusStatus: 'not-computed', bonusReason: 'no quarterly rule for this outlet' })], {
        isQuarterEnd: true,
        bonusNote: 'tenant-wide reason',
      }),
    ).ws[0].cells;
    expect(c['Consistency Bonus (Oct–Dec 2026)']).toBe('— (not computed: no quarterly rule for this outlet)');
    expect(c['Final Points']).toBe(150);
  });

  it('quarter-end, a genuine computed 0 prints 0 and its reason goes to the Reason column', () => {
    const c = buildRows(
      input([bscOutlet({ consistencyBonus: 0, bonusStatus: 'computed', bonusReason: 'missed Nov target' })], { isQuarterEnd: true }),
    ).ws[0].cells;
    expect(c['Consistency Bonus (Oct–Dec 2026)']).toBe(0);
    expect(c.Reason).toBe('No FB2 cases; Consistency bonus 0: missed Nov target');
  });

  it('quarter-end with a null bonus and no status → treated as NOT computed (never a silent 0)', () => {
    const c = buildRows(input([bscOutlet({ consistencyBonus: null })], { isQuarterEnd: true })).ws[0].cells;
    expect(c['Consistency Bonus (Oct–Dec 2026)']).toMatch(/^— \(not computed/);
    expect(c['Final Points']).toBe(150);
  });

  it('quarter-end, bonus not applicable → "— (not applicable)", Final = Total', () => {
    const c = buildRows(input([bscOutlet({ consistencyBonus: null, bonusStatus: 'not-applicable' })], { isQuarterEnd: true })).ws[0].cells;
    expect(c['Consistency Bonus (Oct–Dec 2026)']).toBe('— (not applicable)');
    expect(c['Final Points']).toBe(150);
  });

  it('not quarter-end ignores a bonus value', () => {
    const c = buildRows(input([bscOutlet({ consistencyBonus: 500 })])).ws[0].cells;
    expect(c['Final Points']).toBe(150);
  });

  it('missing bsc / cases / target → zeros, nulls, Gifsy 0', () => {
    const c = buildRows(input([bscOutlet({ bsc: undefined, targets: {}, achievements: {}, ownerName: null })])).ws[0].cells;
    expect(c).toMatchObject({
      'WH Name': '', Target: null, Ach: null, 'Ach%': null, 'Ach WOA': 0,
      'Total Cases': null, 'FB1 Cases': null, 'FB2 Cases': null,
      'Base Points': 0, 'FB1 Points': 0, 'FB2 Points': 0, 'Total Points': 0, Reason: '', 'Final Points': 0, 'Gifsy Approval': 0,
    });
  });

  it('zero target → null Ach%, WOA 0; reasons deduped', () => {
    const c = buildRows(
      input([
        bscOutlet({
          targets: { TOTAL: 0 },
          bsc: { base: { amount: 0, reason: 'Below target' }, fb1: { amount: 0, reason: 'Below target' }, fb2: { amount: 0, reason: 'No FB2' } },
        }),
      ]),
    ).ws[0].cells;
    expect(c['Ach%']).toBeNull();
    expect(c['Ach WOA']).toBe(0);
    expect(c.Reason).toBe('Below target; No FB2');
  });

  it('bonus header follows quarterLabel', () => {
    const c = buildRows(input([bscOutlet()], { quarterLabel: 'Jan–Mar 2027', bonusPaidIn: 'March 2027' })).ws[0].cells;
    expect(c['Consistency Bonus (Jan–Mar 2027)']).toBe('— (paid in March 2027)');
  });

  it('vacant SM on WS', () => {
    const r = buildRows(input([bscOutlet({ chain: chain({ RSM: { active: false } }) })])).ws[0];
    expect(r.cells['SM Name']).toBe('Vacant');
    expect(r.meta.smLabel).toBe('SMHQ — Vacant');
  });
});

describe('buildRows — sorting', () => {
  it('sorts retail by zone, SM HQ, ASM HQ, SO HQ, then numeric-aware code', () => {
    const mk = (code: string, zone: string, sm: string, asm: string, so: string) =>
      outlet({ code, zone, chain: chain({ RSM: { hq: sm }, ASM: { hq: asm }, SO: { hq: so } }) });
    const r = buildRows(
      input([
        mk('10', 'North', 'A', 'A', 'A'),
        mk('2', 'North', 'A', 'A', 'A'),
        mk('1', 'South', 'A', 'A', 'A'),
        mk('5', 'East', 'B', 'A', 'A'),
        mk('6', 'East', 'A', 'B', 'A'),
        mk('7', 'East', 'A', 'A', 'B'),
        mk('8', 'East', 'A', 'A', 'A'),
      ]),
    );
    expect(r.retail.map((x) => x.cells['Customer Code'])).toEqual(['8', '7', '6', '5', '2', '10', '1']);
  });

  it('sorts ws by zone then numeric-aware CODE', () => {
    const r = buildRows(input([bscOutlet({ code: 'W10' }), bscOutlet({ code: 'W9' }), bscOutlet({ code: 'W1', zone: 'East' })]));
    expect(r.ws.map((x) => x.cells.CODE)).toEqual(['W1', 'W9', 'W10']);
  });

  it('does not mutate the input outlets order', () => {
    const outs = [outlet({ code: 'B' }), outlet({ code: 'A' })];
    buildRows(input(outs));
    expect(outs.map((o) => o.code)).toEqual(['B', 'A']);
  });
});
