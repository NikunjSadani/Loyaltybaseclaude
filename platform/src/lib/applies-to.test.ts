import { describe, it, expect } from 'vitest';
import { appliesToOutlet, emptyAppliesTo, isUnscoped, normalizeAppliesTo } from './applies-to';

describe('applies-to (FE mirror)', () => {
  describe('normalizeAppliesTo', () => {
    it('null / undefined / {} → all-empty', () => {
      expect(normalizeAppliesTo(null)).toEqual(emptyAppliesTo());
      expect(normalizeAppliesTo(undefined)).toEqual(emptyAppliesTo());
      expect(normalizeAppliesTo({})).toEqual(emptyAppliesTo());
    });

    it('trims, drops blanks + non-strings, dedupes ci; types UPPERCASED, programs keep spelling', () => {
      expect(
        normalizeAppliesTo({
          outletTypes: [' sss ', 'SSS', '', 5, 'wholesaler'],
          programs: [' Gold ', 'GOLD', 'Silver'],
          subPrograms: ['Tier A', 'tier a', '  '],
        }),
      ).toEqual({ outletTypes: ['SSS', 'WHOLESALER'], programs: ['Gold', 'Silver'], subPrograms: ['Tier A'] });
    });
  });

  it('isUnscoped', () => {
    expect(isUnscoped(null)).toBe(true);
    expect(isUnscoped({ outletTypes: [' '] })).toBe(true);
    expect(isUnscoped({ programs: ['Gold'] })).toBe(false);
  });

  describe('appliesToOutlet', () => {
    const outlet = { outletType: 'SSS', program: 'Gold', subProgram: 'Tier A' };

    it('unscoped → every outlet (even blank facets)', () => {
      expect(appliesToOutlet(null, {})).toBe(true);
      expect(appliesToOutlet(emptyAppliesTo(), outlet)).toBe(true);
    });

    it('OR within a facet, ci + trimmed', () => {
      expect(appliesToOutlet({ outletTypes: ['wholesaler', ' sss '] }, outlet)).toBe(true);
      expect(appliesToOutlet({ programs: ['GOLD'] }, { ...outlet, program: ' gold ' })).toBe(true);
      expect(appliesToOutlet({ subPrograms: ['tier a'] }, outlet)).toBe(true);
    });

    it('AND across facets', () => {
      const scope = { outletTypes: ['SSS'], programs: ['Gold'], subPrograms: ['Tier A'] };
      expect(appliesToOutlet(scope, outlet)).toBe(true);
      expect(appliesToOutlet(scope, { ...outlet, outletType: 'WHOLESALER' })).toBe(false);
      expect(appliesToOutlet(scope, { ...outlet, program: 'Silver' })).toBe(false);
      expect(appliesToOutlet(scope, { ...outlet, subProgram: 'Tier B' })).toBe(false);
    });

    it('D4: non-empty facet + blank outlet value → out of scope; empty facet + blank → in scope', () => {
      expect(appliesToOutlet({ programs: ['Gold'] }, { ...outlet, program: null })).toBe(false);
      expect(appliesToOutlet({ subPrograms: ['Tier A'] }, { ...outlet, subProgram: '  ' })).toBe(false);
      expect(appliesToOutlet({ outletTypes: ['SSS'] }, { ...outlet, outletType: undefined })).toBe(false);
      expect(appliesToOutlet({ programs: [] }, { ...outlet, program: null })).toBe(true);
    });
  });
});
