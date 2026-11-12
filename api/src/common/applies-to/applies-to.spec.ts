// Exhaustive spec for the APPLIES-TO helper (plan §2, §5; decisions D4/D8/D11).
// Run: npx jest src/common/applies-to

import { createHash } from 'crypto';
import {
  appliesToFilter,
  appliesToOutlet,
  canonicalScopeKey,
  emptyAppliesTo,
  fromLegacyOutletType,
  intersectAppliesTo,
  isNoFilterValue,
  isUnscoped,
  kpiAppliesTo,
  legacyOutletTypeOf,
  normalizeAppliesTo,
} from './applies-to';
import { appliesToOutletWhere } from './applies-to.prisma';
import { definitionsHash, KpiDefLite, stableStringify } from '../../sales-import/kpi/sales-kpi.helper';

describe('applies-to helper', () => {
  describe('normalizeAppliesTo', () => {
    it('null / undefined / {} → all-empty', () => {
      expect(normalizeAppliesTo(null)).toEqual(emptyAppliesTo());
      expect(normalizeAppliesTo(undefined)).toEqual(emptyAppliesTo());
      expect(normalizeAppliesTo({})).toEqual(emptyAppliesTo());
      expect(normalizeAppliesTo({ outletTypes: null, programs: null, subPrograms: null })).toEqual(emptyAppliesTo());
    });

    it('trims, drops blanks + non-strings, dedupes case-insensitively (first spelling wins)', () => {
      expect(
        normalizeAppliesTo({
          outletTypes: [' sss ', 'SSS', '', '  ', 5, null, 'wholesaler'],
          programs: ['  Gold ', 'GOLD', 'gold', 'Silver'],
          subPrograms: ['Tier A', 'tier a', ' Tier B'],
        }),
      ).toEqual({ outletTypes: ['SSS', 'WHOLESALER'], programs: ['Gold', 'Silver'], subPrograms: ['Tier A', 'Tier B'] });
    });

    it('UPPERCASES outlet types only; programs/subPrograms keep their spelling', () => {
      const n = normalizeAppliesTo({ outletTypes: ['sss_tot'], programs: ['Kirana Plus'], subPrograms: ['mIxEd'] });
      expect(n).toEqual({ outletTypes: ['SSS_TOT'], programs: ['Kirana Plus'], subPrograms: ['mIxEd'] });
    });

    it('non-array facets → []', () => {
      expect(normalizeAppliesTo({ outletTypes: 'SSS' as unknown as string[] })).toEqual(emptyAppliesTo());
    });

    it('never shares the input array reference', () => {
      const input = { outletTypes: ['SSS'], programs: ['P'], subPrograms: ['S'] };
      const n = normalizeAppliesTo(input);
      expect(n.outletTypes).not.toBe(input.outletTypes);
      expect(n.programs).not.toBe(input.programs);
      expect(n.subPrograms).not.toBe(input.subPrograms);
    });
  });

  describe('isUnscoped', () => {
    it('true for empty / blank-only scopes, false when any facet has a value', () => {
      expect(isUnscoped(null)).toBe(true);
      expect(isUnscoped({ outletTypes: ['  '], programs: [''] })).toBe(true);
      expect(isUnscoped({ outletTypes: ['SSS'] })).toBe(false);
      expect(isUnscoped({ programs: ['P'] })).toBe(false);
      expect(isUnscoped({ subPrograms: ['S'] })).toBe(false);
    });
  });

  describe('appliesToOutlet', () => {
    const outlet = { outletType: 'SSS', program: 'Gold', subProgram: 'Tier A' };

    it('unscoped applies to every outlet, including one with all-blank facets', () => {
      expect(appliesToOutlet(emptyAppliesTo(), outlet)).toBe(true);
      expect(appliesToOutlet(null, {})).toBe(true);
      expect(appliesToOutlet({}, { outletType: null, program: null, subProgram: null })).toBe(true);
    });

    // Full facet matrix: for each facet independently — empty / match / miss / ci-match / blank outlet value.
    const facets: Array<{ key: 'outletTypes' | 'programs' | 'subPrograms'; field: 'outletType' | 'program' | 'subProgram'; val: string }> = [
      { key: 'outletTypes', field: 'outletType', val: 'SSS' },
      { key: 'programs', field: 'program', val: 'Gold' },
      { key: 'subPrograms', field: 'subProgram', val: 'Tier A' },
    ];
    for (const { key, field, val } of facets) {
      describe(`facet ${key}`, () => {
        it('contains the value → in scope', () => {
          expect(appliesToOutlet({ [key]: [val] }, outlet)).toBe(true);
        });
        it('OR within the facet', () => {
          expect(appliesToOutlet({ [key]: ['OTHER', val] }, outlet)).toBe(true);
        });
        it('does not contain the value → out of scope', () => {
          expect(appliesToOutlet({ [key]: ['OTHER'] }, outlet)).toBe(false);
        });
        it('matches trimmed + case-insensitively (both sides)', () => {
          expect(appliesToOutlet({ [key]: [`  ${val.toLowerCase()} `] }, { ...outlet, [field]: ` ${val.toUpperCase()}  ` })).toBe(true);
        });
        it('D4: non-empty facet + blank / null / undefined outlet value → OUT of scope', () => {
          expect(appliesToOutlet({ [key]: [val] }, { ...outlet, [field]: null })).toBe(false);
          expect(appliesToOutlet({ [key]: [val] }, { ...outlet, [field]: '   ' })).toBe(false);
          expect(appliesToOutlet({ [key]: [val] }, { ...outlet, [field]: undefined })).toBe(false);
        });
        it('empty facet + blank outlet value → in scope (empty = all)', () => {
          expect(appliesToOutlet({ [key]: [] }, { ...outlet, [field]: null })).toBe(true);
        });
      });
    }

    it('AND across facets: every non-empty facet must match', () => {
      const scope = { outletTypes: ['SSS'], programs: ['Gold'], subPrograms: ['Tier A'] };
      expect(appliesToOutlet(scope, outlet)).toBe(true);
      expect(appliesToOutlet(scope, { ...outlet, outletType: 'WHOLESALER' })).toBe(false);
      expect(appliesToOutlet(scope, { ...outlet, program: 'Silver' })).toBe(false);
      expect(appliesToOutlet(scope, { ...outlet, subProgram: 'Tier B' })).toBe(false);
    });

    it('D11: sub-programs are independent of programs (no nesting)', () => {
      // A sub-program value that "belongs" to another program still matches if the program facet is empty.
      expect(appliesToOutlet({ subPrograms: ['Tier A'] }, { outletType: 'X', program: 'Silver', subProgram: 'Tier A' })).toBe(true);
    });
  });

  describe('appliesToFilter', () => {
    const scoped = { outletTypes: ['SSS'], programs: ['Gold'], subPrograms: ['Tier A'] };

    it('no filter / empty filter / all-ALL filter → every scope passes', () => {
      expect(appliesToFilter(scoped, null)).toBe(true);
      expect(appliesToFilter(scoped, undefined)).toBe(true);
      expect(appliesToFilter(scoped, {})).toBe(true);
      expect(appliesToFilter(scoped, { outletType: 'ALL', program: 'all', subProgram: '  ' })).toBe(true);
    });

    it('unscoped passes every filter', () => {
      expect(appliesToFilter(emptyAppliesTo(), { outletType: 'WHOLESALER', program: 'X', subProgram: 'Y' })).toBe(true);
    });

    it('facet passes when scope contains the filter value (ci, trimmed)', () => {
      expect(appliesToFilter(scoped, { outletType: ' sss ' })).toBe(true);
      expect(appliesToFilter(scoped, { program: 'GOLD' })).toBe(true);
      expect(appliesToFilter(scoped, { subProgram: 'tier a' })).toBe(true);
    });

    it('facet fails when scope is non-empty and does not contain the filter value', () => {
      expect(appliesToFilter(scoped, { outletType: 'WHOLESALER' })).toBe(false);
      expect(appliesToFilter(scoped, { program: 'Silver' })).toBe(false);
      expect(appliesToFilter(scoped, { subProgram: 'Tier B' })).toBe(false);
    });

    it('a filter on a facet the scope leaves empty passes (program-only KPI vs a type filter)', () => {
      expect(appliesToFilter({ programs: ['Gold'] }, { outletType: 'WHOLESALER' })).toBe(true);
      expect(appliesToFilter({ programs: ['Gold'] }, { outletType: 'WHOLESALER', program: 'Silver' })).toBe(false);
    });

    it('AND across facets', () => {
      expect(appliesToFilter(scoped, { outletType: 'SSS', program: 'Gold' })).toBe(true);
      expect(appliesToFilter(scoped, { outletType: 'SSS', program: 'Silver' })).toBe(false);
    });

    it('isNoFilterValue', () => {
      expect(isNoFilterValue(undefined)).toBe(true);
      expect(isNoFilterValue(null)).toBe(true);
      expect(isNoFilterValue('')).toBe(true);
      expect(isNoFilterValue(' All ')).toBe(true);
      expect(isNoFilterValue('SSS')).toBe(false);
    });
  });

  describe('intersectAppliesTo', () => {
    it('empty ∩ X = X (both directions); empty ∩ empty = empty', () => {
      const x = { outletTypes: ['SSS'], programs: ['Gold'], subPrograms: [] };
      expect(intersectAppliesTo(null, x)).toEqual({ outletTypes: ['SSS'], programs: ['Gold'], subPrograms: [] });
      expect(intersectAppliesTo(x, {})).toEqual({ outletTypes: ['SSS'], programs: ['Gold'], subPrograms: [] });
      expect(intersectAppliesTo(null, null)).toEqual(emptyAppliesTo());
    });

    it('overlapping facets → ci common values (a spelling, a order)', () => {
      expect(
        intersectAppliesTo(
          { outletTypes: ['SSS', 'WHOLESALER', 'SSS_TOT'], programs: ['Gold', 'Silver'] },
          { outletTypes: ['sss_tot', 'sss'], programs: ['GOLD'], subPrograms: ['Tier A'] },
        ),
      ).toEqual({ outletTypes: ['SSS', 'SSS_TOT'], programs: ['Gold'], subPrograms: ['Tier A'] });
    });

    it('a disjoint facet → null (no outlet can match both)', () => {
      expect(intersectAppliesTo({ outletTypes: ['SSS'] }, { outletTypes: ['WHOLESALER'] })).toBeNull();
      expect(intersectAppliesTo({ outletTypes: ['SSS'], programs: ['Gold'] }, { outletTypes: ['SSS'], programs: ['Silver'] })).toBeNull();
      expect(intersectAppliesTo({ subPrograms: ['A'] }, { subPrograms: ['B'] })).toBeNull();
    });

    it('intersection semantics agree with appliesToOutlet on a sample', () => {
      const a = { outletTypes: ['SSS', 'WHOLESALER'], programs: ['Gold'] };
      const b = { outletTypes: ['SSS'], subPrograms: ['Tier A'] };
      const i = intersectAppliesTo(a, b)!;
      const outlets = [
        { outletType: 'SSS', program: 'Gold', subProgram: 'Tier A' },
        { outletType: 'SSS', program: 'Gold', subProgram: 'Tier B' },
        { outletType: 'WHOLESALER', program: 'Gold', subProgram: 'Tier A' },
        { outletType: 'SSS', program: 'Silver', subProgram: 'Tier A' },
        { outletType: 'SSS', program: null, subProgram: 'Tier A' },
      ];
      for (const o of outlets) {
        expect(appliesToOutlet(i, o)).toBe(appliesToOutlet(a, o) && appliesToOutlet(b, o));
      }
    });
  });

  describe('fromLegacyOutletType / kpiAppliesTo / legacyOutletTypeOf', () => {
    it('fromLegacyOutletType: null/blank → unscoped; a code → that one type (UPPERCASED, trimmed)', () => {
      expect(fromLegacyOutletType(null)).toEqual(emptyAppliesTo());
      expect(fromLegacyOutletType(undefined)).toEqual(emptyAppliesTo());
      expect(fromLegacyOutletType('  ')).toEqual(emptyAppliesTo());
      expect(fromLegacyOutletType(' sss ')).toEqual({ outletTypes: ['SSS'], programs: [], subPrograms: [] });
    });

    it('kpiAppliesTo: new arrays win when any facet is non-empty', () => {
      expect(kpiAppliesTo({ outletType: 'SSS', outletTypes: ['WHOLESALER'], programs: [], subPrograms: [] })).toEqual({
        outletTypes: ['WHOLESALER'], programs: [], subPrograms: [],
      });
      expect(kpiAppliesTo({ outletType: null, outletTypes: [], programs: ['Gold'], subPrograms: [] })).toEqual({
        outletTypes: [], programs: ['Gold'], subPrograms: [],
      });
    });

    it('kpiAppliesTo: falls back to legacy outletType when arrays are empty / absent', () => {
      expect(kpiAppliesTo({ outletType: 'SSS' })).toEqual({ outletTypes: ['SSS'], programs: [], subPrograms: [] });
      expect(kpiAppliesTo({ outletType: 'SSS', outletTypes: [], programs: [], subPrograms: [] })).toEqual({
        outletTypes: ['SSS'], programs: [], subPrograms: [],
      });
      expect(kpiAppliesTo({ outletType: null, outletTypes: [], programs: [], subPrograms: [] })).toEqual(emptyAppliesTo());
      expect(kpiAppliesTo({})).toEqual(emptyAppliesTo());
    });

    it('legacyOutletTypeOf: exactly one type and nothing else → that type; else null', () => {
      expect(legacyOutletTypeOf({ outletTypes: ['sss'] })).toBe('SSS');
      expect(legacyOutletTypeOf({})).toBeNull();
      expect(legacyOutletTypeOf({ outletTypes: ['SSS', 'WHOLESALER'] })).toBeNull();
      expect(legacyOutletTypeOf({ outletTypes: ['SSS'], programs: ['Gold'] })).toBeNull();
      expect(legacyOutletTypeOf({ outletTypes: ['SSS'], subPrograms: ['A'] })).toBeNull();
      expect(legacyOutletTypeOf({ programs: ['Gold'] })).toBeNull();
    });
  });

  describe('canonicalScopeKey (definitionsHash fragment, plan §5)', () => {
    it('unscoped → {} (emit nothing)', () => {
      expect(canonicalScopeKey(null)).toEqual({});
      expect(canonicalScopeKey({ outletTypes: [' '], programs: [] })).toEqual({});
    });

    it('exactly one type, no programs/subPrograms → legacy { kpiOutletType }', () => {
      expect(canonicalScopeKey({ outletTypes: [' sss '] })).toEqual({ kpiOutletType: 'SSS' });
    });

    it('anything else → { kpiScope } with sorted, UPPERCASED, deduped lists', () => {
      expect(canonicalScopeKey({ outletTypes: ['WHOLESALER', 'sss'] })).toEqual({
        kpiScope: { outletTypes: ['SSS', 'WHOLESALER'], programs: [], subPrograms: [] },
      });
      expect(canonicalScopeKey({ outletTypes: ['SSS'], programs: ['silver', 'Gold', 'GOLD'], subPrograms: ['b', 'A'] })).toEqual({
        kpiScope: { outletTypes: ['SSS'], programs: ['GOLD', 'SILVER'], subPrograms: ['A', 'B'] },
      });
      expect(canonicalScopeKey({ programs: ['Gold'] })).toEqual({
        kpiScope: { outletTypes: [], programs: ['GOLD'], subPrograms: [] },
      });
    });

    it('is order- and case-insensitive (equivalent scopes → identical key)', () => {
      expect(canonicalScopeKey({ outletTypes: ['A', 'B'], programs: ['x', 'Y'] })).toEqual(
        canonicalScopeKey({ outletTypes: ['b', 'a'], programs: ['y', 'X'] }),
      );
    });

    it('reproduces the CURRENT definitionsHash for unscoped and legacy single-type KPIs (hash stability)', () => {
      const base: KpiDefLite = {
        kpiCode: 'VOL', measure: 'QUANTITY', filter: {}, outletTypes: [], programs: [],
      };
      // Rebuild the hash the way WP-A will (spreading canonicalScopeKey instead of kpiOutletType) and
      // pin it against today's definitionsHash for the two legacy shapes.
      const viaKey = (d: KpiDefLite, scope: Parameters<typeof canonicalScopeKey>[0]) =>
        createHash('sha256')
          .update(
            stableStringify([
              { kpiCode: d.kpiCode, measure: d.measure, filter: d.filter ?? {}, outletTypes: [], programs: [], ...canonicalScopeKey(scope) },
            ]),
          )
          .digest('hex');
      // Sanity: this reproduces the existing hash for an unscoped def.
      expect(viaKey(base, null)).toBe(definitionsHash([base]));
      expect(viaKey(base, fromLegacyOutletType('SSS'))).toBe(definitionsHash([{ ...base, kpiOutletType: 'SSS' }]));
    });
  });

  describe('appliesToOutletWhere (Prisma)', () => {
    it('unscoped → {}', () => {
      expect(appliesToOutletWhere(null)).toEqual({});
      expect(appliesToOutletWhere({ outletTypes: [], programs: [' '] })).toEqual({});
    });

    it('builds AND of per-facet ci ORs on the right outlet columns', () => {
      expect(
        appliesToOutletWhere({ outletTypes: ['sss', 'WHOLESALER'], programs: ['Gold'], subPrograms: ['Tier A', 'Tier B'] }),
      ).toEqual({
        AND: [
          {
            outletType: {
              OR: [
                { code: { equals: 'SSS', mode: 'insensitive' } },
                { code: { equals: 'WHOLESALER', mode: 'insensitive' } },
              ],
            },
          },
          { OR: [{ programName: { equals: 'Gold', mode: 'insensitive' } }] },
          {
            OR: [
              { programCategory: { equals: 'Tier A', mode: 'insensitive' } },
              { programCategory: { equals: 'Tier B', mode: 'insensitive' } },
            ],
          },
        ],
      });
    });

    it('only emits the non-empty facets', () => {
      expect(appliesToOutletWhere({ subPrograms: ['X'] })).toEqual({
        AND: [{ OR: [{ programCategory: { equals: 'X', mode: 'insensitive' } }] }],
      });
    });
  });
});
