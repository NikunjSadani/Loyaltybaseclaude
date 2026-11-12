// Per-outlet KPI applicability helpers (APPLIES-TO D6). Run: npx jest src/sales/outlet-kpi-scope.helper.spec.ts
import { kpiAppliesToOutlet, kpiOutletPredicate, kpisForOutlet, outletPrimaryFallback } from './outlet-kpi-scope.helper';

const k = (code: string, extra: Record<string, unknown> = {}) => ({
  code, isPrimary: false, order: 1, outletType: null, outletTypes: [], programs: [], subPrograms: [], ...extra,
});
const rlpOutlet = { outletType: 'SSS', program: 'RLP', subProgram: null };

describe('outlet-kpi-scope.helper', () => {
  it('kpiOutletPredicate is undefined for an unscoped KPI (callers keep the pre-scope path)', () => {
    expect(kpiOutletPredicate(k('A'))).toBeUndefined();
    expect(kpiOutletPredicate(null)).toBeUndefined();
    expect(kpiOutletPredicate(k('A', { outletType: 'SSS' }))!(rlpOutlet)).toBe(true); // legacy column
  });

  it('kpiAppliesToOutlet: ci match, AND across facets, D4 blank outlet value → out', () => {
    expect(kpiAppliesToOutlet(k('A', { programs: ['rlp'] }), rlpOutlet)).toBe(true);
    expect(kpiAppliesToOutlet(k('A', { programs: ['RLP'], outletTypes: ['WHOLESALER'] }), rlpOutlet)).toBe(false);
    expect(kpiAppliesToOutlet(k('A', { subPrograms: ['Urban'] }), rlpOutlet)).toBe(false);
  });

  it('kpisForOutlet preserves input order and returns everything for unscoped KPIs', () => {
    const defs = [k('B'), k('A', { programs: ['BSC'] }), k('C')];
    expect(kpisForOutlet(defs, rlpOutlet).map((d) => d.code)).toEqual(['B', 'C']);
    const unscoped = [k('B'), k('A')];
    expect(kpisForOutlet(unscoped, rlpOutlet)).toEqual(unscoped);
  });

  it('outletPrimaryFallback: null unless the tenant HAS a primary and none applies to the outlet', () => {
    // no flagged primary at all → never invent one (Deoleo-safe)
    expect(outletPrimaryFallback([k('A'), k('B')], rlpOutlet)).toBeNull();
    // flagged primary in scope → keep tenant flags
    expect(outletPrimaryFallback([k('A', { isPrimary: true }), k('B')], rlpOutlet)).toBeNull();
    // flagged primary out of scope → first in-scope by order, then code
    expect(outletPrimaryFallback([
      k('P', { isPrimary: true, programs: ['BSC'] }),
      k('Z', { order: 2 }),
      k('Y', { order: 2 }),
    ], rlpOutlet)).toBe('Y');
    // nothing in scope → null
    expect(outletPrimaryFallback([k('P', { isPrimary: true, programs: ['BSC'] })], rlpOutlet)).toBeNull();
  });
});
