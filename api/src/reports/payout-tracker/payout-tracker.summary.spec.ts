import { buildSummary } from './payout-tracker.summary';
import { RetailRow, Row, TrackerRows, WsRow, wsColumns, RETAIL_COLUMNS } from './payout-tracker.types';

// ─── fixture builders (cells keyed by the real sheet headers) ──────────────────────────────────────────
type V = string | number | null;
interface R {
  zone: string; sm: string; smLabel: string; asm: string; approved?: boolean;
  program: string; sub: string; tt: V; ta: V; woa: V; working: V; avp: V; lt: V; la: V; payout: V; lm: number | null;
}
function retail(o: R): RetailRow {
  const cells: Row = Object.fromEntries(RETAIL_COLUMNS.map((c) => [c, null]));
  Object.assign(cells, {
    Zone: o.zone, 'SM HQ': o.smLabel, 'ASM HQ': o.asm, Program: o.program, 'Sub- Program': o.sub,
    'Total Target': o.tt, 'Total Ach': o.ta, WOA: o.woa, WORKING: o.working, 'Approved Visibility Payout': o.avp,
    'Line Target': o.lt, 'Line Ach': o.la, 'Total Payout': o.payout,
  });
  return {
    cells,
    meta: { approved: o.approved ?? true, lastMonthTotal: o.lm, smKey: o.sm, smLabel: o.smLabel, asmHq: o.asm, zone: o.zone },
  };
}
interface W { zone: string; sm: string; smLabel: string; approved?: boolean; totalAch: number | null; lm: number | null; fp: V }
function ws(o: W): WsRow {
  const cells: Row = Object.fromEntries(wsColumns('Oct–Dec 2026').map((c) => [c, null]));
  Object.assign(cells, { Zone: o.zone, 'SM HQ': o.smLabel, Ach: o.totalAch, 'Final Points': o.fp });
  return {
    cells,
    meta: { approved: o.approved ?? true, lastMonthTotal: o.lm, smKey: o.sm, smLabel: o.smLabel, zone: o.zone, totalAch: o.totalAch },
  };
}

/** Exact compare of every field; numbers to 10 dp, null must be null. */
function expectLine(actual: object | undefined, expected: Record<string, V>): void {
  expect(actual).toBeDefined();
  const a = actual as Record<string, V>;
  expect(Object.keys(a).sort()).toEqual(Object.keys(expected).sort());
  for (const [k, v] of Object.entries(expected)) {
    if (typeof v === 'number') {
      expect({ k, v: typeof a[k] }).toEqual({ k, v: 'number' });
      expect(a[k] as number).toBeCloseTo(v, 10);
    } else expect({ k, v: a[k] }).toEqual({ k, v });
  }
}
const rlp = (label: string, n: number[], ratios: (number | null)[], score: number | null, rank: number | null) => ({
  label, outlets: n[0], outletsOver100: n[1], woa: ratios[0], valueTarget: n[2], valueAch: n[3], achPct: ratios[1],
  visEligible: n[4], visAttempted: n[5], visApproved: n[6], visApprovedPct: ratios[2], linesOver100: n[7], linesPct: ratios[3],
  score, rank,
});
const nb = (label: string, d: number, e: number, f: number, g: number | null, h: number, hp: number | null, i: number, j: number) => ({
  label, retailOutlets: d, wsOutlets: e, retailZero: f, retailZeroPct: g, wsZero: h, wsZeroPct: hp, lmZeroRetail: i, lmZeroWs: j,
});

// ─── main fixture: 4 retail zones incl. 2 unknown (Alpha, Central), West only unapproved, South only in WS ───
const U = { program: 'Unnati', sub: 'Unnati' };
const LITE = { program: 'Unnati', sub: 'Lite' };
const SAMT = { program: 'SAMT', sub: 'SAMT' };
const N1 = { zone: 'North', sm: 'sm-n1', smLabel: 'SM Delhi' };
const N2 = { zone: 'North', sm: 'sm-n2', smLabel: 'SM Agra' };
const E1 = { zone: 'East', sm: 'sm-e1', smLabel: 'SM Kolkata' };
const C1 = { zone: 'Central', sm: 'sm-c1', smLabel: 'SM Bhopal' };
const X1 = { zone: 'Alpha', sm: 'sm-x1', smLabel: 'SM Alpha' };
const S1 = { zone: 'South', sm: 'sm-s1', smLabel: 'SM Chennai' };
const W1 = { zone: 'West', sm: 'sm-w1', smLabel: 'SM Pune' };

const main: TrackerRows = {
  retail: [
    retail({ ...N1, ...U, asm: 'A1', tt: 1000, ta: 1200, woa: 1, working: 1, avp: 1, lt: 10, la: 12, payout: 500, lm: 5000 }), // r1
    // Lite: WORKING/approved visibility present but NOT eligible → excluded from J/K/L
    retail({ ...N1, ...LITE, asm: 'A1', tt: 1000, ta: 500, woa: 0, working: 1, avp: 1, lt: 10, la: 5, payout: 100, lm: 0 }), // r2
    // Line Target 0 → never counts as lines ≥ 100% even with Ach 0 ≥ 0
    retail({ ...N2, ...SAMT, asm: 'A2', tt: 2000, ta: 0, woa: 0, working: 1, avp: 0, lt: 0, la: 0, payout: 0, lm: null }), // r3
    // unapproved → excluded everywhere except totals.retailPayout
    retail({ ...N2, ...U, asm: 'A2', approved: false, tt: 9999, ta: 9999, woa: 1, working: 1, avp: 1, lt: 9, la: 9, payout: 300, lm: null }), // r4
    retail({ ...E1, ...U, asm: 'A3', tt: 500, ta: 500, woa: 1, working: 0, avp: 0, lt: 5, la: 5, payout: 250, lm: 100 }), // r5
    // nulls everywhere → 0; negative last month → lm-zero
    retail({ ...E1, ...LITE, asm: 'A3', tt: null, ta: null, woa: 0, working: null, avp: null, lt: null, la: null, payout: null, lm: -5 }), // r6
    // G = 0 → achPct null; K = 0 → visApprovedPct null; non-numeric payout ignored
    retail({ ...C1, ...SAMT, asm: 'A4', tt: 0, ta: 0, woa: 0, working: 0, avp: 0, lt: 0, la: 0, payout: 'NA', lm: 10 }), // r7
    retail({ ...X1, ...U, asm: 'A5', tt: 100, ta: 100, woa: 1, working: 1, avp: 1, lt: 1, la: 1, payout: 50, lm: 1 }), // r8
    // West has ONLY an unapproved outlet → West must not appear anywhere
    retail({ ...W1, ...U, asm: 'A6', approved: false, tt: 100, ta: 100, woa: 1, working: 1, avp: 1, lt: 1, la: 1, payout: 0, lm: 1 }), // r9
  ],
  ws: [
    ws({ ...N1, totalAch: 1000, lm: 500, fp: 40 }), // w1
    ws({ ...N1, totalAch: 0, lm: 0, fp: 0 }), // w2
    ws({ ...S1, totalAch: null, lm: null, fp: 20 }), // w3
    ws({ ...S1, approved: false, totalAch: 0, lm: null, fp: 15 }), // w4 unapproved (points still summed)
  ],
  exceptions: [],
};

describe('buildSummary — main multi-zone fixture', () => {
  const s = buildSummary(main);

  it('zoneRlp: known zones first (North, East), then unknown alphabetically; no West (unapproved-only) / South (WS-only); Total last', () => {
    expect(s.zoneRlp.map((l) => l.label)).toEqual(['North', 'East', 'Alpha', 'Central', 'Total']);
    // North: r1,r2,r3 — Lite r2 not eligible; r3 LT=0 not a line
    expectLine(s.zoneRlp[0], rlp('North', [3, 1, 4000, 1700, 2, 2, 1, 1], [1 / 3, 0.425, 0.5, 1 / 3], 0.1 + 0.1275 + 0.1 + 0.2 / 3, 3));
    // East: K = 0 → visApprovedPct null, counts 0 in score; r6 nulls → 0
    expectLine(s.zoneRlp[1], rlp('East', [2, 1, 500, 500, 1, 0, 0, 1], [0.5, 1, null, 0.5], 0.55, 2));
    expectLine(s.zoneRlp[2], rlp('Alpha', [1, 1, 100, 100, 1, 1, 1, 1], [1, 1, 1, 1], 1, 1));
    // Central: G = 0 → achPct null; K = 0 → null
    expectLine(s.zoneRlp[3], rlp('Central', [1, 0, 0, 0, 1, 0, 0, 0], [0, null, null, 0], 0, 4));
  });

  it('zoneRlp Total: ratios recomputed from summed counts, rank null', () => {
    const woa = 3 / 7, ach = 2300 / 4600, vis = 2 / 3, lines = 3 / 7;
    expectLine(s.zoneRlp[4], rlp('Total', [7, 3, 4600, 2300, 5, 3, 2, 3], [woa, ach, vis, lines], 0.3 * woa + 0.3 * ach + 0.2 * vis + 0.2 * lines, null));
  });

  it('zoneNotBilling: South (WS only) appears after the known zones before unknown ones; West absent', () => {
    expect(s.zoneNotBilling.map((l) => l.label)).toEqual(['North', 'East', 'South', 'Alpha', 'Central', 'Total']);
    expectLine(s.zoneNotBilling[0], nb('North', 3, 2, 1, 1 / 3, 1, 0.5, 2, 1)); // lm: r2=0, r3=null; ws w2=0
    expectLine(s.zoneNotBilling[1], nb('East', 2, 0, 1, 0.5, 0, null, 1, 0)); // r6 Total Ach null → zero; lm -5 → zero
    expectLine(s.zoneNotBilling[2], nb('South', 0, 1, 0, null, 1, 1, 0, 1)); // w4 unapproved excluded; w3 totalAch null → zero
    expectLine(s.zoneNotBilling[3], nb('Alpha', 1, 0, 0, 0, 0, null, 0, 0)); // lm 1 positive
    expectLine(s.zoneNotBilling[4], nb('Central', 1, 0, 1, 1, 0, null, 0, 0));
    expectLine(s.zoneNotBilling[5], nb('Total', 7, 3, 3, 3 / 7, 2, 2 / 3, 3, 2));
  });

  it('smRlp: grouped by zone order then label; ties share a rank; Total last', () => {
    expect(s.smRlp.map((l) => l.label)).toEqual(['SM Agra', 'SM Delhi', 'SM Kolkata', 'SM Alpha', 'SM Bhopal', 'Total']);
    expectLine(s.smRlp[0], rlp('SM Agra', [1, 0, 2000, 0, 1, 1, 0, 0], [0, 0, 0, 0], 0, 4));
    expectLine(s.smRlp[1], rlp('SM Delhi', [2, 1, 2000, 1700, 1, 1, 1, 1], [0.5, 0.85, 1, 0.5], 0.15 + 0.255 + 0.2 + 0.1, 2));
    expectLine(s.smRlp[2], rlp('SM Kolkata', [2, 1, 500, 500, 1, 0, 0, 1], [0.5, 1, null, 0.5], 0.55, 3));
    expectLine(s.smRlp[3], rlp('SM Alpha', [1, 1, 100, 100, 1, 1, 1, 1], [1, 1, 1, 1], 1, 1));
    expectLine(s.smRlp[4], rlp('SM Bhopal', [1, 0, 0, 0, 1, 0, 0, 0], [0, null, null, 0], 0, 4)); // ties with SM Agra
    expect(s.smRlp[5]).toEqual(s.zoneRlp[4]);
  });

  it('smNotBilling: includes the WS-only SM (South) in zone order', () => {
    expect(s.smNotBilling.map((l) => l.label)).toEqual(['SM Agra', 'SM Delhi', 'SM Kolkata', 'SM Chennai', 'SM Alpha', 'SM Bhopal', 'Total']);
    expectLine(s.smNotBilling[0], nb('SM Agra', 1, 0, 1, 1, 0, null, 1, 0));
    expectLine(s.smNotBilling[1], nb('SM Delhi', 2, 2, 0, 0, 1, 0.5, 1, 1));
    expectLine(s.smNotBilling[2], nb('SM Kolkata', 2, 0, 1, 0.5, 0, null, 1, 0));
    expectLine(s.smNotBilling[3], nb('SM Chennai', 0, 1, 0, null, 1, 1, 0, 1));
    expectLine(s.smNotBilling[4], nb('SM Alpha', 1, 0, 0, 0, 0, null, 0, 0));
    expectLine(s.smNotBilling[5], nb('SM Bhopal', 1, 0, 1, 1, 0, null, 0, 0));
    expect(s.smNotBilling[6]).toEqual(s.zoneNotBilling[5]);
  });

  it('bottomAsm with < 10 groups: all returned, worst first, ties by label, ranks among all ASMs (unapproved-only A6 absent)', () => {
    expect(s.bottomAsm.map((l) => [l.label, l.rank])).toEqual([['A2', 4], ['A4', 4], ['A3', 3], ['A1', 2], ['A5', 1]]);
    expectLine(s.bottomAsm[0], rlp('A2', [1, 0, 2000, 0, 1, 1, 0, 0], [0, 0, 0, 0], 0, 4));
    expectLine(s.bottomAsm[3], rlp('A1', [2, 1, 2000, 1700, 1, 1, 1, 1], [0.5, 0.85, 1, 0.5], 0.705, 2));
  });

  it('totals: payout / points over ALL rows (numeric only), outlet counts approved only', () => {
    expect(s.totals).toEqual({ retailPayout: 1200, wsPoints: 75, retailOutlets: 7, wsOutlets: 3 });
  });
});

describe('buildSummary — bottomAsm with > 10 ASM groups', () => {
  // 12 ASMs, one outlet each; score = 0.3 × Total Ach / 100 (everything else 0)
  const ach: Record<string, number> = { B01: 50, B02: 10, B03: 20, B04: 30, B05: 40, B06: 60, B07: 70, B08: 80, B09: 90, B10: 100, B11: 10, B12: 110 };
  const rows: TrackerRows = {
    retail: Object.entries(ach).map(([asm, ta]) =>
      retail({ ...N1, ...U, asm, tt: 100, ta, woa: 0, working: 0, avp: 0, lt: 0, la: 0, payout: 1, lm: 1 })),
    ws: [],
    exceptions: [],
  };
  const s = buildSummary(rows);

  it('returns the 10 lowest, worst first, tie broken by label, ranks across all 12', () => {
    expect(s.bottomAsm.map((l) => [l.label, l.rank])).toEqual([
      ['B02', 11], ['B11', 11], ['B03', 10], ['B04', 9], ['B05', 8], ['B01', 7], ['B06', 6], ['B07', 5], ['B08', 4], ['B09', 3],
    ]);
    expect(s.bottomAsm[0].score).toBeCloseTo(0.03, 10);
    expect(s.bottomAsm[9].score).toBeCloseTo(0.27, 10);
  });
});

describe('buildSummary — edge cases', () => {
  it('empty input: only Total lines, all ratios + score null, zero totals', () => {
    const s = buildSummary({ retail: [], ws: [], exceptions: [] });
    expect(s.zoneRlp).toHaveLength(1);
    expectLine(s.zoneRlp[0], rlp('Total', [0, 0, 0, 0, 0, 0, 0, 0], [null, null, null, null], null, null));
    expect(s.smRlp).toEqual(s.zoneRlp);
    expectLine(s.zoneNotBilling[0], nb('Total', 0, 0, 0, null, 0, null, 0, 0));
    expect(s.smNotBilling).toEqual(s.zoneNotBilling);
    expect(s.bottomAsm).toEqual([]);
    expect(s.totals).toEqual({ retailPayout: 0, wsPoints: 0, retailOutlets: 0, wsOutlets: 0 });
  });

  it('all-unapproved input counts nothing but still sums payout / points', () => {
    const s = buildSummary({
      retail: [retail({ ...N1, ...U, asm: 'A1', approved: false, tt: 1, ta: 1, woa: 1, working: 1, avp: 1, lt: 1, la: 1, payout: 70, lm: 1 })],
      ws: [ws({ ...S1, approved: false, totalAch: 5, lm: 5, fp: 9 })],
      exceptions: [],
    });
    expect(s.zoneRlp.map((l) => l.label)).toEqual(['Total']);
    expect(s.zoneNotBilling.map((l) => l.label)).toEqual(['Total']);
    expect(s.bottomAsm).toEqual([]);
    expect(s.totals).toEqual({ retailPayout: 70, wsPoints: 9, retailOutlets: 0, wsOutlets: 0 });
  });

  it('known zones are ordered case-insensitively; unknowns alphabetically after them', () => {
    const z = (zone: string) => ws({ zone, sm: `sm-${zone}`, smLabel: `SM ${zone}`, totalAch: 1, lm: 1, fp: 0 });
    const s = buildSummary({ retail: [], ws: ['Zeta', 'south', 'Beta', 'EAST', 'North', 'west'].map(z), exceptions: [] });
    expect(s.zoneNotBilling.map((l) => l.label)).toEqual(['North', 'EAST', 'west', 'south', 'Beta', 'Zeta', 'Total']);
  });

  it('lastMonthTotal: null and 0 and negative count as last-month zero, positive does not', () => {
    const mk = (lm: number | null) => retail({ ...N1, ...U, asm: 'A1', tt: 1, ta: 1, woa: 0, working: 0, avp: 0, lt: 0, la: 0, payout: 0, lm });
    const s = buildSummary({ retail: [mk(null), mk(0), mk(-1), mk(0.5), mk(100)], ws: [], exceptions: [] });
    expect(s.zoneNotBilling[0].lmZeroRetail).toBe(3);
  });
});
