/// <reference types="vitest/globals" />
/**
 * Product-set (multi combo) filter logic — plan §6.2a. Neutral fixtures (dimA / dimB).
 * Run: npx vitest run src/lib/sales-import/__tests__/product-set.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeDim, normalizeEntry, addEntries, removeEntry, removeEntryAt, hasEntry, entryLabel,
  coveringEntryIndex, validateFilter, describeFilter,
} from '../product-set';
import type { DimMatch, SalesDimensionMapping } from '../types';

const DIMS: SalesDimensionMapping[] = [
  { key: 'dimA', label: 'Brand', header: 'A' },
  { key: 'dimB', label: 'SKU group', header: 'B' },
];

describe('normalize', () => {
  it.each([[500, '500'], [' p  q ', 'P Q'], ['', ''], [null, '']])('normalizeDim(%p) → %p', (i, o) => {
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
