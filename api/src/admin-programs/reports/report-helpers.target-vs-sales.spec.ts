// Unit tests for the Target vs Sales pure helpers (no Prisma / no DI).
// Run: npx jest src/admin-programs/reports/report-helpers.target-vs-sales.spec.ts

import {
  buildTargetVsSalesRows,
  PaceMonthResult,
  targetVsSalesHeaderKeys,
  targetVsSalesMonthList,
  TARGET_VS_SALES_MAX_MONTHS,
} from './report-helpers';

const KPIS = [
  { code: 'MONTH_TGT', label: 'Month Target', unit: 'cases' },
  { code: 'FOCUS_PACK_1', label: 'Focus Pack - 1', unit: 'cases' },
];

describe('targetVsSalesMonthList', () => {
  it('builds an inclusive YYYY-MM list across a year boundary', () => {
    expect(targetVsSalesMonthList('2025-11', '2026-02')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
  });

  it('accepts a single month and exactly the 15-month max', () => {
    expect(targetVsSalesMonthList('2026-03', '2026-03')).toEqual(['2026-03']);
    expect(targetVsSalesMonthList('2025-01', '2026-03')).toHaveLength(TARGET_VS_SALES_MAX_MONTHS);
  });

  it('throws when the span exceeds 15 months', () => {
    // 2025-01 .. 2026-04 = 16 months
    expect(() => targetVsSalesMonthList('2025-01', '2026-04')).toThrow(RangeError);
  });

  it('throws when from is after to', () => {
    expect(() => targetVsSalesMonthList('2026-05', '2026-03')).toThrow(RangeError);
  });
});

describe('targetVsSalesHeaderKeys', () => {
  it('emits 4 lead columns then Target/Achieved/Pace % per KPI in order', () => {
    expect(targetVsSalesHeaderKeys(KPIS)).toEqual([
      'Outlet Code',
      'Outlet Name',
      'Outlet Type',
      'Month',
      'Month Target Target',
      'Month Target Achieved',
      'Month Target Pace %',
      'Focus Pack - 1 Target',
      'Focus Pack - 1 Achieved',
      'Focus Pack - 1 Pace %',
    ]);
  });
});

describe('buildTargetVsSalesRows', () => {
  it('produces a full (outlet × month) grid, blank cells for months with no data', () => {
    const months = ['2026-01', '2026-02'];
    const pace: PaceMonthResult[] = [
      {
        month: '2026-01',
        outlets: [
          {
            outletCode: 'OUT-1',
            outletName: 'Alpha',
            outletType: 'RETAIL',
            month: '2026-01',
            kpis: [{ code: 'MONTH_TGT', target: 100, achieved: 80, pace: 0.8 }],
          },
        ],
      },
      { month: '2026-02', outlets: [] }, // no data in Feb
    ];

    const { rows } = buildTargetVsSalesRows(months, KPIS, pace);
    expect(rows).toHaveLength(2); // 1 outlet × 2 months
    expect(rows[0]['Month']).toBe('2026-01');
    expect(rows[0]['Month Target Pace %']).toBe(80); // 0.8 → 80.0 → 80
    expect(rows[1]['Month']).toBe('2026-02');
    // Feb has no data → all KPI cells blank.
    expect(rows[1]['Month Target Target']).toBe('');
    expect(rows[1]['Month Target Achieved']).toBe('');
    expect(rows[1]['Month Target Pace %']).toBe('');
  });

  it('blank (not 0) for an absent key; a real 0 is preserved; pace null → blank', () => {
    const pace: PaceMonthResult[] = [
      {
        month: '2026-01',
        outlets: [
          {
            outletCode: 'OUT-1',
            outletName: 'Alpha',
            outletType: 'RETAIL',
            month: '2026-01',
            kpis: [
              // target present but 0 → target 0, pace null (÷0 guard) → blank.
              { code: 'MONTH_TGT', target: 0, achieved: 5, pace: null },
              // achieved absent → achieved blank, pace null → blank; target shown.
              { code: 'FOCUS_PACK_1', target: 20, achieved: null, pace: null },
            ],
          },
        ],
      },
    ];

    const { rows } = buildTargetVsSalesRows(['2026-01'], KPIS, pace);
    const r = rows[0];
    expect(r['Month Target Target']).toBe(0); // real 0 preserved
    expect(r['Month Target Achieved']).toBe(5);
    expect(r['Month Target Pace %']).toBe(''); // ÷0 guard → blank
    expect(r['Focus Pack - 1 Target']).toBe(20);
    expect(r['Focus Pack - 1 Achieved']).toBe(''); // absent actual → blank
    expect(r['Focus Pack - 1 Pace %']).toBe('');
  });

  it('rounds pace to one decimal', () => {
    const pace: PaceMonthResult[] = [
      {
        month: '2026-01',
        outlets: [
          {
            outletCode: 'OUT-1',
            outletName: 'Alpha',
            outletType: 'RETAIL',
            month: '2026-01',
            kpis: [{ code: 'MONTH_TGT', target: 8, achieved: 7, pace: 7 / 8 }], // 0.875 → 87.5
          },
        ],
      },
    ];
    const { rows } = buildTargetVsSalesRows(['2026-01'], KPIS, pace);
    expect(rows[0]['Month Target Pace %']).toBe(87.5);
  });

  it('orders rows by outletCode then month; every row carries the identical key set', () => {
    const months = ['2026-01', '2026-02'];
    const outletAt = (code: string, month: string) => ({
      outletCode: code,
      outletName: code,
      outletType: 'RETAIL',
      month,
      kpis: [{ code: 'MONTH_TGT', target: 10, achieved: 10, pace: 1 }],
    });
    const pace: PaceMonthResult[] = [
      { month: '2026-01', outlets: [outletAt('B-2', '2026-01'), outletAt('A-1', '2026-01')] },
      { month: '2026-02', outlets: [outletAt('A-1', '2026-02')] },
    ];

    const { rows, headerKeys } = buildTargetVsSalesRows(months, KPIS, pace);
    // A-1 (both months) then B-2 (both months) — 2 outlets × 2 months = 4 rows.
    expect(rows.map((r) => [r['Outlet Code'], r['Month']])).toEqual([
      ['A-1', '2026-01'],
      ['A-1', '2026-02'],
      ['B-2', '2026-01'],
      ['B-2', '2026-02'],
    ]);
    for (const r of rows) expect(Object.keys(r)).toEqual(headerKeys);
  });

  it('includes an outlet with only an actual (no target) as a qualifying row', () => {
    const pace: PaceMonthResult[] = [
      {
        month: '2026-01',
        outlets: [
          {
            outletCode: 'OUT-9',
            outletName: 'Solo Actual',
            outletType: 'WHOLESALE',
            month: '2026-01',
            kpis: [{ code: 'MONTH_TGT', target: null, achieved: 42, pace: null }],
          },
        ],
      },
    ];
    const { rows } = buildTargetVsSalesRows(['2026-01'], KPIS, pace);
    expect(rows).toHaveLength(1);
    expect(rows[0]['Month Target Target']).toBe(''); // no target → blank
    expect(rows[0]['Month Target Achieved']).toBe(42);
  });
});
