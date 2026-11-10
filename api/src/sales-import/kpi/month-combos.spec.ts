import { classifyMonthSummaries, insertMonthCombosSql } from './month-combos';

const AT = new Date('2026-11-01T10:00:00.000Z');

describe('classifyMonthSummaries (from the set header stamp alone)', () => {
  const head = (month: string, over: Partial<{ lineRows: number; combosSourceImportId: string | null; combosAppliedAt: Date | null }> = {}) => ({
    month, sourceImportId: `imp-${month}`, appliedAt: AT, lineRows: 5, combosSourceImportId: `imp-${month}`, combosAppliedAt: AT, ...over,
  });

  it('current / stale (other import or other apply time) / missing (never stamped, has lines) / empty', () => {
    const s = classifyMonthSummaries([
      head('2026-01'),
      head('2026-02', { combosSourceImportId: 'imp-OLD' }),
      head('2026-03', { combosAppliedAt: new Date(AT.getTime() - 1) }),
      head('2026-04', { combosSourceImportId: null, combosAppliedAt: null }),
      head('2026-05', { combosSourceImportId: null, combosAppliedAt: null, lineRows: 0 }),
    ]);
    expect(Object.fromEntries(s)).toEqual({ '2026-01': 'current', '2026-02': 'stale', '2026-03': 'stale', '2026-04': 'missing', '2026-05': 'empty' });
  });
});

describe('insertMonthCombosSql (the apply\'s summary write)', () => {
  it('one INSERT … SELECT grouped by dimKey + dims, stamped with the set', () => {
    const q = insertMonthCombosSql('t1', '2026-10', 'imp1', AT);
    expect(q.sql).toMatch(/INSERT INTO "sales_month_history_combos"/);
    expect(q.sql).toMatch(/GROUP BY h\."clientId", h\."month", h\."dimKey", h\."dims"\s*$/);
    expect(q.sql).not.toMatch(/array_agg/);
    expect(q.values).toEqual(['imp1', AT.toISOString(), 't1', '2026-10']);
  });
});

describe('no background rebuild (lead decision 2026-11-10)', () => {
  it('the module exports only the apply write + the read-side classification', () => {
    const mod = jest.requireActual('./month-combos') as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual(['classifyMonthSummaries', 'insertMonthCombosSql']);
  });
});
