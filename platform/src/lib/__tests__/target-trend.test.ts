/// <reference types="vitest/globals" />
import { describe, it, expect } from 'vitest';
import { buildChartSeries, hasData, type TrendPoint } from '../target-trend';

describe('buildChartSeries — partner dashboard chart from REAL primary-KPI trend', () => {
  it('TT1: monthly view = the last 6 months, labelled, target/achieved passed through (null preserved)', () => {
    const trend: TrendPoint[] = [
      { month: '2025-11', target: 50, achieved: 40 },
      { month: '2025-12', target: 60, achieved: 55 },
      { month: '2026-01', target: 70, achieved: 65 },
      { month: '2026-02', target: 80, achieved: 70 },
      { month: '2026-03', target: 90, achieved: 88 },
      { month: '2026-04', target: 100, achieved: null }, // no achievement yet
    ];
    const { monthly } = buildChartSeries(trend);
    expect(monthly).toHaveLength(6);
    expect(monthly[0]).toEqual({ month: 'Nov', target: 50, achieved: 40 });
    expect(monthly[5]).toEqual({ month: 'Apr', target: 100, achieved: null }); // honest gap, not 0
  });

  it('TT2: monthly view keeps only the latest 6 when more months are present', () => {
    const trend: TrendPoint[] = Array.from({ length: 9 }, (_, i) => ({
      month: `2026-0${i + 1}`, target: i + 1, achieved: i,
    }));
    const { monthly } = buildChartSeries(trend);
    expect(monthly).toHaveLength(6);
    expect(monthly[0].month).toBe('Apr'); // 2026-04 (months 4..9)
    expect(monthly[5].month).toBe('Sep');
  });

  it('TT3: YoY view buckets by Indian FY (Apr→Mar); achievement → fy26 (current) / fy25 (prev), target from current FY', () => {
    const trend: TrendPoint[] = [
      // prev FY (FY 24-25): Apr 2024
      { month: '2024-04', target: 30, achieved: 25 },
      // current FY (FY 25-26): Apr 2025 + May 2025
      { month: '2025-04', target: 40, achieved: 38 },
      { month: '2025-05', target: 42, achieved: 20 },
    ];
    const { yoy, yoyLabels } = buildChartSeries(trend);
    expect(yoyLabels).toEqual({ prev: 'FY 24-25', cur: 'FY 25-26' });
    const apr = yoy.find(p => p.month === 'Apr')!;
    expect(apr).toEqual({ month: 'Apr', target: 40, fy25: 25, fy26: 38 });
    const may = yoy.find(p => p.month === 'May')!;
    expect(may).toEqual({ month: 'May', target: 42, fy25: null, fy26: 20 });
    // FY month order starts at Apr and ends at Mar
    expect(yoy[0].month).toBe('Apr');
    expect(yoy[11].month).toBe('Mar');
  });

  it('TT4: hasData — empty / all-null series is treated as no data', () => {
    expect(hasData([])).toBe(false);
    expect(hasData([{ target: null, achieved: null }])).toBe(false);
    expect(hasData([{ target: null, achieved: 5 }])).toBe(true);
    expect(buildChartSeries([]).monthly).toEqual([]);
  });
});
