import {
  normalizeDim,
  normalizeHeader,
  normalizeOutletCode,
  parseInvoiceDate,
  parseInvoiceDateDetailed,
  stableDimKey,
  microToCases,
  paiseToRupees,
  toMicro,
  toPaise,
} from './normalize';

// Plan §6.1 / task I-1. All dates are derived from Date.UTC or from "today" (date-relative-tests rule):
// nothing here depends on the wall clock except via the injected `today`.
const DAY = 86_400_000;
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const excelSerial = (y: number, m0: number, d: number) => (Date.UTC(y, m0, d) - Date.UTC(1899, 11, 30)) / DAY;

describe('normalizeHeader', () => {
  it.each([
    [' customer  code ', 'CUSTOMER CODE'],
    ['﻿CODE', 'CODE'],
    ['Qty (Cases)', 'QTY (CASES)'],
    ['net\tamt', 'NET AMT'],
    [null, ''],
    [12, '12'],
  ])('normalizeHeader(%p) → %p', (i, o) => expect(normalizeHeader(i)).toBe(o));

  it('"CODE" and "CUSTOMER CODE" stay distinct', () =>
    expect(normalizeHeader('code')).not.toBe(normalizeHeader('customer code')));
});

describe('normalizeDim', () => {
  it.each([
    [500, '500'],
    [500.0, '500'],
    [0.5, '0.5'],
    [' cno  enrich ', 'CNO ENRICH'],
    ['adho', 'ADHO'],
    ['500.0', '500'],
    ['500.50', '500.5'],
    ['0500', '0500'], // leading zeros are data, not formatting
    ['', ''],
    ['   ', ''],
    [null, ''],
    [undefined, ''],
    [Number.NaN, ''],
    [true, 'TRUE'],
  ])('normalizeDim(%p) → %p', (i, o) => expect(normalizeDim(i)).toBe(o));

  it('an xlsx number cell and a CSV text cell of the same size normalize identically', () =>
    expect(normalizeDim(500)).toBe(normalizeDim(' 500 ')));
});

describe('normalizeOutletCode', () => {
  it.each([
    [327852, '327852'],
    [327852.0, '327852'],
    [' 00123 ', '00123'],
    ['327852.0', '327852'],
    ['327852.00', '327852'],
    ['A-12.0', 'A-12.0'], // only a pure number string loses its ".0"
    [null, ''],
    ['', ''],
  ])('normalizeOutletCode(%p) → %p', (i, o) => expect(normalizeOutletCode(i)).toBe(o));
});

describe('toPaise', () => {
  it.each([
    ['1,234.50', 123450n],
    [-12.345, -1235n], // half away from zero on the DECIMAL value, not the float product
    [12.345, 1235n],
    ['₹ 10', 1000n],
    ['Rs. 10', null],
    [100, 10000n],
    [0, 0n],
    ['-40.00', -4000n],
    ['(40.00)', -4000n], // accounting negative
    ['40.00-', -4000n], // trailing-minus (ERP export)
    ['.5', 50n],
    ['1.005', 101n],
    [1.005, 101n],
    ['12,34,567.89', 123456789n], // Indian grouping
    ['', null],
    ['  ', null],
    [null, null],
    ['abc', null],
    ['1.2.3', null],
    [Number.POSITIVE_INFINITY, null],
    [Number.NaN, null],
  ])('toPaise(%p) → %p', (i, o) => expect(toPaise(i)).toBe(o));
});

describe('toMicro', () => {
  it('keeps fractional cases', () => expect(toMicro('0.04')).toBe(40000n));
  it.each([
    [1.5, 1_500_000n],
    [-0.5, -500_000n],
    ['2', 2_000_000n],
    [0.0000005, 1n], // 5e-7 → rounds half away from zero to 1 micro
    [1e-7, 0n],
    ['', null],
    ['x', null],
  ])('toMicro(%p) → %p', (i, o) => expect(toMicro(i)).toBe(o));
});

describe('parseInvoiceDate', () => {
  const TODAY = '2026-11-09';

  it.each([
    ['05-10-2026', 'DMY', '2026-10-05'],
    ['05/10/2026', 'DMY', '2026-10-05'],
    ['05.10.2026', 'DMY', '2026-10-05'],
    ['10/05/2026', 'MDY', '2026-10-05'],
    ['05/Oct/2026', 'DMY', '2026-10-05'],
    ['05-oct-2026', 'MDY', '2026-10-05'], // a month NAME is unambiguous whatever the order
    ['5-October-2026', 'DMY', '2026-10-05'],
    ['Oct-05-2026', 'DMY', '2026-10-05'],
    ['2026-10-05', 'YMD', '2026-10-05'],
    ['2026-10-05', 'DMY', '2026-10-05'], // a 4-digit first token is always Y-M-D
    ['2026/10/05', 'MDY', '2026-10-05'],
    ['05-10-26', 'DMY', '2026-10-05'], // 2-digit year → 20yy
    [' 05-10-2026 ', 'DMY', '2026-10-05'],
    ['05-10-2026 23:59', 'DMY', '2026-10-05'], // a wall-clock time without zone = IST local, date kept
    ['2026-10-05T10:00:00', 'YMD', '2026-10-05'],
  ])('parseInvoiceDate(%p, %p) → %p', (v, ord, out) =>
    expect(parseInvoiceDate(v, ord as 'DMY' | 'MDY' | 'YMD', TODAY)).toBe(out));

  it('an excel serial number (1900 system) maps to its calendar date', () =>
    expect(parseInvoiceDate(excelSerial(2026, 9, 5), 'DMY', TODAY)).toBe('2026-10-05'));

  it('a serial with a time fraction keeps the calendar day', () =>
    expect(parseInvoiceDate(excelSerial(2026, 9, 5) + 0.99, 'DMY', TODAY)).toBe('2026-10-05'));

  it('a Date cell uses its UTC Y-M-D (exceljs date cells are naive UTC)', () =>
    expect(parseInvoiceDate(new Date(Date.UTC(2026, 9, 5)), 'DMY', TODAY)).toBe('2026-10-05'));

  it('a zoned timestamp text is converted to the IST calendar day', () => {
    // 2026-10-31T20:00Z = 2026-11-01 01:30 IST → November.
    expect(parseInvoiceDate('2026-10-31T20:00:00Z', 'YMD', TODAY)).toBe('2026-11-01');
    expect(parseInvoiceDate('2026-10-31T20:00:00+05:30', 'YMD', TODAY)).toBe('2026-10-31');
  });

  it.each([
    ['31-02-2026', 'DMY'],
    ['29-02-2026', 'DMY'],
    ['00-10-2026', 'DMY'],
    ['05-13-2026', 'DMY'],
    ['13/13/2026', 'MDY'],
    ['05-Foo-2026', 'DMY'],
    ['hello', 'DMY'],
    ['', 'DMY'],
    ['5', 'DMY'],
  ])('rejects %p (%p)', (v, ord) => expect(parseInvoiceDate(v, ord as 'DMY', TODAY)).toBeNull());

  it('accepts 29-02 in a leap year', () => expect(parseInvoiceDate('29-02-2024', 'DMY', TODAY)).toBe('2024-02-29'));

  it('rejects dates before 2000 and after today+1 (window relative to the injected today)', () => {
    const today = isoOf(Date.now());
    const tomorrow = isoOf(Date.now() + DAY);
    const dayAfter = isoOf(Date.now() + 2 * DAY);
    expect(parseInvoiceDate(today, 'YMD', today)).toBe(today);
    expect(parseInvoiceDate(tomorrow, 'YMD', today)).toBe(tomorrow);
    expect(parseInvoiceDate(dayAfter, 'YMD', today)).toBeNull();
    expect(parseInvoiceDate('1999-12-31', 'YMD', today)).toBeNull();
    expect(parseInvoiceDate('2000-01-01', 'YMD', today)).toBe('2000-01-01');
  });

  it('detailed variant explains WHY a date was rejected', () => {
    expect(parseInvoiceDateDetailed('31-02-2026', 'DMY', TODAY)).toEqual({ reason: 'invalid date' });
    expect(parseInvoiceDateDetailed('', 'DMY', TODAY)).toEqual({ reason: 'blank date' });
    expect(parseInvoiceDateDetailed('1999-01-01', 'YMD', TODAY)).toEqual({ reason: 'date out of range' });
    expect(parseInvoiceDateDetailed('2026-10-05', 'YMD', TODAY)).toEqual({ date: '2026-10-05' });
  });

  it('defaults "today" to the current IST day when not injected', () => {
    expect(parseInvoiceDate('2000-01-01', 'YMD')).toBe('2000-01-01');
    expect(parseInvoiceDate(isoOf(Date.now() + 3 * DAY), 'YMD')).toBeNull();
  });
});

describe('stableDimKey', () => {
  it('is independent of key insertion order', () =>
    expect(stableDimKey({ dimB: '500', dimA: 'X' })).toBe('{"dimA":"X","dimB":"500"}'));
  it('is "{}" for no dims', () => expect(stableDimKey({})).toBe('{}'));
});

describe('paiseToRupees / microToCases (single source for BigInt → wire numbers)', () => {
  it('inverts toPaise / toMicro', () => {
    expect(paiseToRupees(toPaise('1,234.50')!)).toBe(1234.5);
    expect(paiseToRupees(-1235n)).toBe(-12.35);
    expect(microToCases(toMicro('0.04')!)).toBe(0.04);
    expect(microToCases(1_750_000n)).toBe(1.75);
  });
});
