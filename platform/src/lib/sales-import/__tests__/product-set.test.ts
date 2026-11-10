/// <reference types="vitest/globals" />
/**
 * Product-set (multi combo) filter logic — plan §6.2a. Neutral fixtures (dimA / dimB).
 * Run: npx vitest run src/lib/sales-import/__tests__/product-set.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeDim, normalizeEntry, addEntries, removeEntry, removeEntryAt, hasEntry, entryLabel,
  coveringEntryIndex, validateFilter, describeFilter, comboEntry, entryMatchesDims, includeExcludeConflicts, entriesNotInCombos,
  isAllBlank, comboMappingDrift, dimensionKeyDrift,
} from '../product-set';
import type { DimMatch, SalesDimensionMapping } from '../types';

const DIMS: SalesDimensionMapping[] = [
  { key: 'dimA', label: 'Brand', header: 'A' },
  { key: 'dimB', label: 'SKU group', header: 'B' },
];

describe('normalize', () => {
  // SAME vectors as api/src/sales-import/ingest/normalize.spec.ts `normalizeDim` (keep the two tables identical).
  it.each([
    [500, '500'],
    [500.0, '500'],
    [0.5, '0.5'],
    [' cno  enrich ', 'CNO ENRICH'],
    ['adho', 'ADHO'],
    ['500.0', '500'],
    ['500.50', '500.5'],
    ['0500', '0500'],
    ['', ''],
    ['   ', ''],
    [null, ''],
    [undefined, ''],
    [Number.NaN, ''],
    [true, 'TRUE'],
    [' p  q ', 'P Q'],
  ])('normalizeDim(%p) → %p (backend parity)', (i, o) => {
    expect(normalizeDim(i)).toBe(o);
  });
  it('normalizeEntry drops blank keys', () => {
    expect(normalizeEntry({ dimA: ' adho ', dimB: '  ' })).toEqual({ dimA: 'ADHO' });
  });
});

describe('addEntries / removeEntry', () => {
  it('picking 3 combos produces the expected anyOf', () => {
    const { filter, added } = addEntries({}, 'anyOf', [
      { dimA: 'P', dimB: '500' }, { dimA: 'P', dimB: '200' }, { dimA: 'p', dimB: '150' },
    ]);
    expect(added).toBe(3);
    expect(filter).toEqual({ anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'P', dimB: '200' }, { dimA: 'P', dimB: '150' }] });
  });

  it('de-duplicates (after normalization) and reports duplicates', () => {
    const r = addEntries({ anyOf: [{ dimA: 'P' }] }, 'anyOf', [{ dimA: ' p ' }, { dimA: 'Q' }]);
    expect(r.filter.anyOf).toEqual([{ dimA: 'P' }, { dimA: 'Q' }]);
    expect(r.duplicates).toBe(1);
  });

  it('skips empty entries', () => {
    expect(addEntries({}, 'noneOf', [{ dimA: ' ' }]).filter).toEqual({});
  });

  it('removing the last entry drops the list key (so {} means all lines)', () => {
    const f = { anyOf: [{ dimA: 'P' }], noneOf: [{ dimA: 'P', dimB: '50' }] };
    expect(removeEntryAt(f, 'noneOf', 0)).toEqual({ anyOf: [{ dimA: 'P' }] });
    expect(removeEntry(f, 'anyOf', { dimA: 'p' })).toEqual({ noneOf: [{ dimA: 'P', dimB: '50' }] });
  });

  it('hasEntry is key-order and case insensitive', () => {
    expect(hasEntry({ anyOf: [{ dimA: 'P', dimB: '500' }] }, 'anyOf', { dimB: '500', dimA: 'p' })).toBe(true);
  });
});

describe('labels', () => {
  it('a full combo reads "P 500"', () => expect(entryLabel({ dimA: 'P', dimB: '500' }, DIMS)).toBe('P 500'));
  it('a whole-brand entry reads "(all sku groups)"', () =>
    expect(entryLabel({ dimA: 'CNO' }, DIMS)).toBe('CNO (all sku groups)'));
  it('describeFilter', () => {
    expect(describeFilter({}, DIMS)).toBe('All products');
    expect(describeFilter({ noneOf: [{ dimA: 'P' }] }, DIMS)).toBe('All products except P (all sku groups)');
    expect(describeFilter({ anyOf: [{ dimA: 'P', dimB: '500' }, { dimA: 'Q' }] }, DIMS))
      .toBe('P 500 + Q (all sku groups)');
  });
});

describe('coveringEntryIndex', () => {
  it('finds the whole-brand entry that already includes a combo', () => {
    const entries: DimMatch[] = [{ dimA: 'P', dimB: '500' }, { dimA: 'P' }, { dimA: 'Q', dimB: '500' }];
    expect(coveringEntryIndex(entries, 0)).toBe(1);
    expect(coveringEntryIndex(entries, 1)).toBe(-1);
    expect(coveringEntryIndex(entries, 2)).toBe(-1);
  });
});

describe('validateFilter (blocking)', () => {
  const keys = ['dimA', 'dimB'];
  it('accepts {} and a normal set', () => {
    expect(validateFilter({}, keys).errors).toEqual([]);
    expect(validateFilter({ anyOf: [{ dimA: 'P' }], noneOf: [{ dimA: 'P', dimB: '50' }] }, keys).errors).toEqual([]);
  });
  it('blocks an empty entry', () => {
    expect(validateFilter({ anyOf: [{}] }, keys).errors[0]).toMatch(/entry 1 is empty/);
  });
  it('blocks an unknown dimension key', () => {
    expect(validateFilter({ anyOf: [{ colour: 'RED' }] }, keys).errors[0]).toMatch(/"colour"/);
  });
  it('blocks more than 200 entries', () => {
    const anyOf = Array.from({ length: 201 }, (_, i) => ({ dimA: `V${i}` }));
    expect(validateFilter({ anyOf }, keys).errors[0]).toMatch(/at most 200/);
  });
});

describe('blank values, conflicts, live checks, cap (audit fixes)', () => {
  const dims = [{ key: 'dimA', label: 'Brand', header: 'A' }, { key: 'dimB', label: 'Size', header: 'B' }];

  it('normalizeEntry keeps blanks only when asked; comboEntry pins the combo\'s own columns (blank included)', () => {
    expect(normalizeEntry({ dimA: 'p', dimB: ' ' }, { keepBlank: true })).toEqual({ dimA: 'P', dimB: '' });
    expect(comboEntry({ dimA: 'P', dimB: '' }, dims)).toEqual({ dimA: 'P', dimB: '' });
    // a column the combo's import did not have is NOT pinned; one no longer mapped is dropped
    expect(comboEntry({ dimA: 'P' }, dims)).toEqual({ dimA: 'P' });
    expect(comboEntry({ dimA: 'P', gone: 'X' }, dims)).toEqual({ dimA: 'P' });
    expect(entryLabel({ dimA: 'P', dimB: '' }, dims)).toBe('P (blank size)');
  });

  it('entryMatchesDims treats a missing dim as blank (mirrors backend entryMatches)', () => {
    expect(entryMatchesDims({ dimB: '' }, { dimA: 'P' })).toBe(true);
    expect(entryMatchesDims({ dimB: '' }, { dimA: 'P', dimB: '5' })).toBe(false);
  });

  it('includeExcludeConflicts: same entry, and an exclusion that covers an inclusion', () => {
    expect(includeExcludeConflicts({ anyOf: [{ dimA: 'P', dimB: '5' }, { dimA: 'Q' }], noneOf: [{ dimA: 'P' }, { dimA: 'Q' }] }))
      .toEqual([{ include: 0, exclude: 0, kind: 'cancels' }, { include: 1, exclude: 1, kind: 'same' }]);
    expect(includeExcludeConflicts({ anyOf: [{ dimA: 'P' }], noneOf: [{ dimA: 'P', dimB: '5' }] })).toEqual([]);
  });

  it('entriesNotInCombos is null when the combo list is capped (absence is not proof)', () => {
    const combos = [{ dims: { dimA: 'P', dimB: '5' } }];
    expect(entriesNotInCombos({ anyOf: [{ dimA: 'P' }, { dimA: 'Z' }], noneOf: [{ dimB: '9' }] }, combos, 2000))
      .toEqual({ anyOf: [1], noneOf: [0] });
    expect(entriesNotInCombos({ anyOf: [{ dimA: 'Z' }] }, combos, 1)).toBeNull();
  });

  it('addEntries respects a max and reports what did not fit', () => {
    const r = addEntries({ anyOf: [{ dimA: 'A' }] }, 'anyOf', [{ dimA: 'B' }, { dimA: 'C' }], { max: 2 });
    expect(r.added).toBe(1);
    expect(r.overCap).toBe(1);
    expect(r.filter.anyOf).toHaveLength(2);
  });

  it('validateFilter: SOME blank values are fine; ALL blank (or {}) is refused', () => {
    expect(validateFilter({ anyOf: [{ dimA: 'P', dimB: '' }] }, ['dimA', 'dimB']).errors).toEqual([]);
    expect(validateFilter({ anyOf: [{ dimA: '' }] }, ['dimA']).errors[0]).toMatch(/only blank values/);
    expect(validateFilter({ noneOf: [{ dimA: '', dimB: '' }] }, ['dimA', 'dimB']).errors[0]).toMatch(/only blank values/);
    expect(validateFilter({ anyOf: [{}] }, ['dimA']).errors[0]).toMatch(/empty/);
  });

  it('isAllBlank / addEntries refuse all-blank entries and count them', () => {
    expect(isAllBlank({ dimA: '', dimB: ' ' })).toBe(true);
    expect(isAllBlank({ dimA: 'P', dimB: '' })).toBe(false);
    expect(isAllBlank({})).toBe(false);
    const r = addEntries({}, 'anyOf', [{ dimA: '', dimB: '' }, { dimA: 'P', dimB: '' }], { keepBlank: true });
    expect(r.allBlank).toBe(1);
    expect(r.filter.anyOf).toEqual([{ dimA: 'P', dimB: '' }]);
  });

  it('comboMappingDrift reports columns the file lacks / the mapping no longer has', () => {
    expect(comboMappingDrift([{ dims: { dimA: 'P', dimB: '' } }], dims)).toBeNull();
    expect(comboMappingDrift([{ dims: { dimA: 'P', old: 'x' } }], dims)).toEqual({ missing: ['dimB'], extra: ['old'] });
    expect(comboMappingDrift([], dims)).toBeNull();
  });

  it('dimensionKeyDrift compares a stored set\'s declared keys with the mapping (history source)', () => {
    expect(dimensionKeyDrift(['dimA', 'dimB'], dims)).toBeNull();
    expect(dimensionKeyDrift(['dimA', 'old'], dims)).toEqual({ missing: ['dimB'], extra: ['old'] });
    expect(dimensionKeyDrift([], dims)).toBeNull(); // nothing stored → nothing to compare
  });

  it('entriesNotInCombos is null when the caller knows the list is capped, even below the max', () => {
    const combos = [{ dims: { dimA: 'P', dimB: '5' } }];
    expect(entriesNotInCombos({ anyOf: [{ dimA: 'Z' }] }, combos, 2000, true)).toBeNull();
    expect(entriesNotInCombos({ anyOf: [{ dimA: 'Z' }] }, combos, 2000, false)).toEqual({ anyOf: [0], noneOf: [] });
  });
});
