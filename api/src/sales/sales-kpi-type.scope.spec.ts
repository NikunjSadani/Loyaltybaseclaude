// Scope-aware KPI resolvers (APPLIES-TO plan §2, D6/D7). The legacy type-only spec
// (sales-kpi-type.helper.spec.ts) stays unchanged and must keep passing.
// Run: npx jest src/sales/sales-kpi-type

import {
  KpiTypeLike,
  kpisForOutletType,
  kpisForScopeFilter,
  primaryKpiFor,
  primaryKpiForOutletType,
} from './sales-kpi-type.helper';

const k = (
  code: string,
  scope: { outletType?: string | null; outletTypes?: string[]; programs?: string[]; subPrograms?: string[] } = {},
  isPrimary = false,
  order = 0,
): KpiTypeLike => ({
  code,
  isPrimary,
  order,
  outletType: scope.outletType ?? null,
  outletTypes: scope.outletTypes ?? [],
  programs: scope.programs ?? [],
  subPrograms: scope.subPrograms ?? [],
});

const codes = (xs: KpiTypeLike[]) => xs.map((x) => x.code);

describe('sales-kpi-type.helper — scope-aware resolvers', () => {
  const defs = [
    k('SHARED', {}, false, 1),
    k('MULTI', { outletTypes: ['SSS', 'SSS_TOT'] }, false, 2),
    k('WHOLE', { outletTypes: ['WHOLESALER'] }, false, 3),
    k('GOLD', { programs: ['Gold'] }, false, 4),
    k('SSS_GOLD_A', { outletTypes: ['SSS'], programs: ['Gold'], subPrograms: ['Tier A'] }, false, 5),
    k('LEGACY_SSS', { outletType: 'SSS' }, false, 6), // pre-migration row shape (arrays empty)
  ];

  describe('kpisForScopeFilter', () => {
    it('no filter / ALL everywhere → every KPI (ordered)', () => {
      const all = ['SHARED', 'MULTI', 'WHOLE', 'GOLD', 'SSS_GOLD_A', 'LEGACY_SSS'];
      expect(codes(kpisForScopeFilter(defs))).toEqual(all);
      expect(codes(kpisForScopeFilter(defs, null))).toEqual(all);
      expect(codes(kpisForScopeFilter(defs, { outletType: 'ALL', program: 'ALL', subProgram: 'ALL' }))).toEqual(all);
    });

    it('multi-type KPI appears under EACH of its types', () => {
      expect(codes(kpisForScopeFilter(defs, { outletType: 'SSS' }))).toEqual(['SHARED', 'MULTI', 'GOLD', 'SSS_GOLD_A', 'LEGACY_SSS']);
      expect(codes(kpisForScopeFilter(defs, { outletType: 'SSS_TOT' }))).toEqual(['SHARED', 'MULTI', 'GOLD']);
      expect(codes(kpisForScopeFilter(defs, { outletType: 'WHOLESALER' }))).toEqual(['SHARED', 'WHOLE', 'GOLD']);
    });

    it('type filter matches case-insensitively and trimmed', () => {
      expect(codes(kpisForScopeFilter(defs, { outletType: ' sss_tot ' }))).toEqual(['SHARED', 'MULTI', 'GOLD']);
    });

    it('program filter narrows program-scoped KPIs; type-only KPIs ride along (D7)', () => {
      expect(codes(kpisForScopeFilter(defs, { program: 'Silver' }))).toEqual(['SHARED', 'MULTI', 'WHOLE', 'LEGACY_SSS']);
      expect(codes(kpisForScopeFilter(defs, { program: 'gold' }))).toEqual(['SHARED', 'MULTI', 'WHOLE', 'GOLD', 'SSS_GOLD_A', 'LEGACY_SSS']);
    });

    it('type + program + sub-program filters combine with AND', () => {
      expect(codes(kpisForScopeFilter(defs, { outletType: 'SSS', program: 'Gold', subProgram: 'Tier B' }))).toEqual([
        'SHARED', 'MULTI', 'GOLD', 'LEGACY_SSS',
      ]);
      expect(codes(kpisForScopeFilter(defs, { outletType: 'WHOLESALER', program: 'Gold' }))).toEqual(['SHARED', 'WHOLE', 'GOLD']);
    });

    it('new arrays WIN over the legacy outletType column', () => {
      const d = [k('X', { outletType: 'SSS', outletTypes: ['WHOLESALER'] })];
      expect(codes(kpisForScopeFilter(d, { outletType: 'SSS' }))).toEqual([]);
      expect(codes(kpisForScopeFilter(d, { outletType: 'WHOLESALER' }))).toEqual(['X']);
    });

    it('does not mutate the input array', () => {
      const input = [k('B', {}, false, 2), k('A', {}, false, 1)];
      kpisForScopeFilter(input, { outletType: 'SSS' });
      expect(codes(input)).toEqual(['B', 'A']);
    });
  });

  describe('primaryKpiFor (D6 fallback)', () => {
    it('picks the isPrimary KPI within the in-scope set', () => {
      const d = [k('A', {}, false, 1), k('P', { programs: ['Gold'] }, true, 2)];
      expect(primaryKpiFor(d, { program: 'Gold' })?.code).toBe('P');
    });

    it('out-of-scope tenant primary → falls back to the first in-scope KPI by order', () => {
      const d = [k('Z', { outletTypes: ['WHOLESALER'] }, false, 3), k('P', { programs: ['Gold'] }, true, 1), k('B', { outletTypes: ['SSS'] }, false, 2)];
      expect(primaryKpiFor(d, { outletType: 'SSS', program: 'Silver' })?.code).toBe('B');
    });

    it('null when no KPI is in scope', () => {
      const d = [k('P', { programs: ['Gold'] }, true, 1)];
      expect(primaryKpiFor(d, { program: 'Silver' })).toBeNull();
    });

    it('no filter → the tenant primary (same as the rest of the sales service)', () => {
      const d = [k('A', {}, false, 1), k('P', { programs: ['Gold'] }, true, 2)];
      expect(primaryKpiFor(d)?.code).toBe('P');
    });
  });

  describe('legacy wrappers = scope resolvers with { outletType }', () => {
    const filters: Array<string | null | undefined> = [undefined, null, '', 'ALL', 'SSS', 'SSS_TOT', 'WHOLESALER', 'NONE'];
    for (const t of filters) {
      it(`type=${JSON.stringify(t)}`, () => {
        expect(codes(kpisForOutletType(defs, t))).toEqual(codes(kpisForScopeFilter(defs, { outletType: t })));
        expect(primaryKpiForOutletType(defs, t)?.code).toBe(primaryKpiFor(defs, { outletType: t })?.code);
      });
    }

    it('legacy-only rows (no arrays at all) resolve exactly as before', () => {
      const legacy: KpiTypeLike[] = [
        { code: 'SHARED', outletType: null, isPrimary: false, order: 1 },
        { code: 'RLP', outletType: 'SSS', isPrimary: true, order: 2 },
        { code: 'BSC', outletType: 'WHOLESALER', isPrimary: false, order: 3 },
      ];
      expect(codes(kpisForOutletType(legacy, 'SSS'))).toEqual(['SHARED', 'RLP']);
      expect(codes(kpisForOutletType(legacy, 'WHOLESALER'))).toEqual(['SHARED', 'BSC']);
      expect(codes(kpisForOutletType(legacy))).toEqual(['SHARED', 'RLP', 'BSC']);
      expect(primaryKpiForOutletType(legacy, 'WHOLESALER')?.code).toBe('SHARED');
      expect(primaryKpiForOutletType(legacy, 'SSS')?.code).toBe('RLP');
    });

    it('post-backfill rows (outletType mirrored into outletTypes) resolve identically to legacy-only rows', () => {
      const legacy = [k('S', {}, false, 1), k('R', { outletType: 'SSS' }, true, 2), k('W', { outletType: 'WHOLESALER' }, false, 3)];
      const backfilled = [
        k('S', {}, false, 1),
        k('R', { outletType: 'SSS', outletTypes: ['SSS'] }, true, 2),
        k('W', { outletType: 'WHOLESALER', outletTypes: ['WHOLESALER'] }, false, 3),
      ];
      for (const t of filters) {
        expect(codes(kpisForOutletType(backfilled, t))).toEqual(codes(kpisForOutletType(legacy, t)));
        expect(primaryKpiForOutletType(backfilled, t)?.code).toBe(primaryKpiForOutletType(legacy, t)?.code);
      }
    });
  });
});
