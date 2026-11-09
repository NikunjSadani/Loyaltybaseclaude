import { normalizeDim, normalizeHeader, normalizeOutletCode } from './normalize';

// Lane-0 seed spec for the three normalizers Lane K depends on (plan §6.1). Lane I owns this file and
// extends it with toPaise / toMicro / parseInvoiceDate (task I-1).
describe('normalize (Lane-0 seed)', () => {
  it.each([
    [' customer  code ', 'CUSTOMER CODE'],
    ['﻿CODE', 'CODE'],
    ['Qty (Cases)', 'QTY (CASES)'],
  ])('normalizeHeader(%p) → %p', (i, o) => expect(normalizeHeader(i)).toBe(o));

  it('"CODE" and "CUSTOMER CODE" stay distinct', () =>
    expect(normalizeHeader('code')).not.toBe(normalizeHeader('customer code')));

  it.each([
    [500, '500'],
    [500.0, '500'],
    [' cno  enrich ', 'CNO ENRICH'],
    ['', ''],
    [null, ''],
  ])('normalizeDim(%p) → %p', (i, o) => expect(normalizeDim(i)).toBe(o));

  it.each([
    [327852, '327852'],
    [327852.0, '327852'],
    [' 00123 ', '00123'],
    [null, ''],
  ])('normalizeOutletCode(%p) → %p', (i, o) => expect(normalizeOutletCode(i)).toBe(o));
});
