// Unit tests for the per-outlet-type KPI filter helper.
// Run: npx jest src/sales/sales-kpi-type.helper.spec.ts

import { kpisForOutletType, primaryKpiForOutletType, KpiTypeLike } from './sales-kpi-type.helper';

const k = (
  code: string,
  outletType: string | null,
  isPrimary = false,
  order = 0,
): KpiTypeLike => ({ code, outletType, isPrimary, order });

describe('sales-kpi-type.helper', () => {
  describe('kpisForOutletType', () => {
    it('with NO type → returns ALL KpiDefs (ordered), filter is a no-op (Deoleo-identical)', () => {
      const defs = [k('B', null, false, 2), k('A', null, true, 1)];
      const res = kpisForOutletType(defs);
      expect(res.map((x) => x.code)).toEqual(['A', 'B']); // sorted by order
    });

    it("'ALL' sentinel behaves like no type (no filter)", () => {
      const defs = [k('A', null), k('S', 'SSS'), k('W', 'WHOLESALER')];
      expect(kpisForOutletType(defs, 'ALL').map((x) => x.code).sort()).toEqual(['A', 'S', 'W']);
    });

    it('with a type → keeps SHARED (null) + that-type KPIs, drops other-type KPIs', () => {
      const defs = [
        k('SHARED', null, false, 1),
        k('RLP_ONLY', 'SSS', false, 2),
        k('BSC_ONLY', 'WHOLESALER', false, 3),
      ];
      expect(kpisForOutletType(defs, 'SSS').map((x) => x.code)).toEqual(['SHARED', 'RLP_ONLY']);
      expect(kpisForOutletType(defs, 'WHOLESALER').map((x) => x.code)).toEqual(['SHARED', 'BSC_ONLY']);
    });

    it('orders by configured order then code', () => {
      const defs = [k('Z', null, false, 1), k('A', null, false, 1), k('M', null, false, 0)];
      expect(kpisForOutletType(defs, null).map((x) => x.code)).toEqual(['M', 'A', 'Z']);
    });
  });

  describe('primaryKpiForOutletType', () => {
    it('picks the isPrimary KPI within the filtered set', () => {
      const defs = [k('SHARED', null, false, 1), k('RLP', 'SSS', true, 2)];
      expect(primaryKpiForOutletType(defs, 'SSS')?.code).toBe('RLP');
    });

    it('falls back to the first-by-order KPI when none is marked primary', () => {
      const defs = [k('B', null, false, 2), k('A', null, false, 1)];
      expect(primaryKpiForOutletType(defs, null)?.code).toBe('A');
    });

    it('a type-specific primary is EXCLUDED for a different type → shared primary wins', () => {
      const defs = [k('SHARED', null, true, 1), k('BSC', 'WHOLESALER', true, 2)];
      // For SSS, the WHOLESALER primary is filtered out; the shared primary is the pick.
      expect(primaryKpiForOutletType(defs, 'SSS')?.code).toBe('SHARED');
      // For WHOLESALER, both are primary → first by order (SHARED, order 1) wins.
      expect(primaryKpiForOutletType(defs, 'WHOLESALER')?.code).toBe('SHARED');
    });

    it('returns null for an empty set (type has no shared and no matching KPI)', () => {
      const defs = [k('BSC', 'WHOLESALER', true, 1)];
      // Request a type with no shared KPIs and no matching type → empty → null.
      expect(primaryKpiForOutletType(defs, 'SSS')).toBeNull();
    });

    it('no-type call resolves the SAME primary the rest of the service uses (isPrimary else first)', () => {
      const defs = [k('A', null, false, 1), k('P', null, true, 2)];
      expect(primaryKpiForOutletType(defs)?.code).toBe('P');
    });
  });
});
