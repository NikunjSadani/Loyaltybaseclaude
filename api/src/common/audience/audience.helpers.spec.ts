import {
  ancestorSalesUserIds,
  applyDndSuppression,
  hasOutletFilter,
  isValidPhone,
  matchesOutletFilter,
  phoneLast10,
} from './audience.helpers';

describe('audience.helpers (pure, shared by schemes + whatsapp)', () => {
  describe('phoneLast10 / isValidPhone', () => {
    it('canonicalises to the last 10 digits, stripping +91/91/punctuation', () => {
      expect(phoneLast10('+91 98300-11252')).toBe('9830011252');
      expect(phoneLast10('919830011252')).toBe('9830011252');
      expect(phoneLast10('9830011252')).toBe('9830011252');
    });
    it('handles null/empty', () => {
      expect(phoneLast10(null)).toBe('');
      expect(phoneLast10(undefined)).toBe('');
      expect(phoneLast10('abc')).toBe('');
    });
    it('validates a bare 10-digit mobile', () => {
      expect(isValidPhone('9830011252')).toBe(true);
      expect(isValidPhone('98300')).toBe(false);
      expect(isValidPhone('')).toBe(false);
    });
  });

  describe('hasOutletFilter / matchesOutletFilter (inclusion-only)', () => {
    it('no filter → matches everything', () => {
      expect(hasOutletFilter(undefined)).toBe(false);
      expect(hasOutletFilter({})).toBe(false);
      expect(matchesOutletFilter(undefined, { zone: 'North' })).toBe(true);
    });
    it('a set facet narrows by inclusion', () => {
      expect(hasOutletFilter({ zones: ['North'] })).toBe(true);
      expect(matchesOutletFilter({ zones: ['North'] }, { zone: 'North' })).toBe(true);
      expect(matchesOutletFilter({ zones: ['North'] }, { zone: 'South' })).toBe(false);
    });
    it('a null attribute never satisfies a set facet', () => {
      expect(matchesOutletFilter({ zones: ['North'] }, { zone: null })).toBe(false);
    });
    it('ALL set facets must pass (AND semantics)', () => {
      const filter = { zones: ['North'], programNames: ['P1'] };
      expect(matchesOutletFilter(filter, { zone: 'North', programName: 'P1' })).toBe(true);
      expect(matchesOutletFilter(filter, { zone: 'North', programName: 'P2' })).toBe(false);
    });
  });

  describe('ancestorSalesUserIds (up-hierarchy walk)', () => {
    const edges = [
      { id: 'ho', reportingToId: null },
      { id: 'asm', reportingToId: 'ho' },
      { id: 'so', reportingToId: 'asm' },
      { id: 'isr', reportingToId: 'so' },
    ];
    it('returns the tagged user + every ancestor', () => {
      expect([...ancestorSalesUserIds(['isr'], edges)].sort()).toEqual(['asm', 'ho', 'isr', 'so']);
    });
    it('is cycle-safe', () => {
      const cyclic = [
        { id: 'a', reportingToId: 'b' },
        { id: 'b', reportingToId: 'a' },
      ];
      expect([...ancestorSalesUserIds(['a'], cyclic)].sort()).toEqual(['a', 'b']);
    });
  });

  describe('applyDndSuppression (opt-out hook)', () => {
    it('is a no-op for an empty suppression set (returns a copy)', () => {
      const input = new Set(['9830011252', '6289864191']);
      const out = applyDndSuppression(input);
      expect([...out].sort()).toEqual([...input].sort());
      expect(out).not.toBe(input); // new set
    });
    it('removes suppressed phones', () => {
      const out = applyDndSuppression(new Set(['a', 'b', 'c']), new Set(['b']));
      expect([...out].sort()).toEqual(['a', 'c']);
    });
  });
});
