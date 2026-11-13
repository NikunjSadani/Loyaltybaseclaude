/// <reference types="vitest/globals" />
/**
 * Sales Import display helpers + apply gating.
 * Run: npx vitest run src/lib/sales-import/__tests__/format.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  applyBlockers, monthLabel, dayLabel, warningText, formatSigned, formatRupees, formatBytes, sentence, formatCases,
  formatKpiValue, formatProducts, measureUnitLabel,
} from '../format';
import { EMPTY_MONTH_RECONCILIATION, type MonthPreview } from '../types';

function month(over: Partial<MonthPreview>): MonthPreview {
  return {
    month: '2026-05', firstDate: '2026-05-01', lastDate: '2026-05-31', lines: 10, matchedOutlets: 2,
    unmatchedCustomers: 1, matchedAmountRupees: 100, matchedQuantity: 1, unmatchedAmountRupees: 5,
    unmatchedQuantity: 0, monthState: 'OPEN', canApply: true, warnings: [], zeroFillOutlets: 0, kpis: [],
    lastApplied: null, reconciliation: EMPTY_MONTH_RECONCILIATION, ...over,
  };
}

describe('labels', () => {
  it('monthLabel / dayLabel', () => {
    expect(monthLabel('2026-05')).toBe('May 2026');
    expect(dayLabel('2026-10-05')).toBe('05 Oct');
  });
  it('partial-month text names the start day and the whole-month consequence', () => {
    expect(warningText('STARTS_AFTER_FIRST', month({ firstDate: '2026-05-05' })))
      .toMatch(/starts on 05 May.*replaces ALL of May 2026/);
  });
  it('formatSigned / formatRupees / formatBytes', () => {
    expect(formatSigned(-1500, formatRupees)).toBe('−₹1,500');
    expect(formatSigned(20, formatRupees)).toBe('+₹20');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
  it('rupees: 2 decimals whenever there are paise, minus before the symbol', () => {
    expect(formatRupees(1500)).toBe('₹1,500');
    expect(formatRupees(1500.5)).toBe('₹1,500.50');
    expect(formatRupees(0.1 + 0.2)).toBe('₹0.30');
    expect(formatRupees(-500)).toBe('−₹500');
    expect(formatRupees(-1234.5)).toBe('−₹1,234.50');
    expect(formatRupees(-0.001)).toBe('₹0');
  });
  it('cases: typographic minus, up to 3 decimals, no "−0"', () => {
    expect(formatCases(-12.5)).toBe('−12.5');
    expect(formatCases(1.2345)).toBe('1.235');
    expect(formatCases(-0.0001)).toBe('0');
  });
  it('bytes: binary units, no "1024.0 KB"', () => {
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1.0 MB');
    expect(formatBytes(600 * 1024 * 1024)).toBe('600.0 MB');
  });
  it('sentence() avoids ".." when a server message already ends with a full stop', () => {
    expect(`${sentence('Closed.')}. Next`).toBe('Closed. Next');
    expect(sentence(null)).toBe('');
  });
  it('MAPPING_CHANGED has plain-English text and a short chip label', () => {
    expect(warningText('MAPPING_CHANGED', { month: '2026-10', firstDate: '2026-10-01', lastDate: '2026-10-31' }))
      .toMatch(/column settings changed after this month was saved.*check the totals/);
  });
  it('older-data text compares this file with the applied range', () => {
    expect(warningText('OLDER_THAN_LAST_APPLIED', {
      month: '2026-10', firstDate: '2026-10-01', lastDate: '2026-10-20',
      lastApplied: { importId: 'x', at: '', byName: 'R', lastInvoiceDate: '2026-10-31' },
    })).toMatch(/stop on 20 Oct, but the file applied last time goes up to 31 Oct/);
  });
});

describe('applyBlockers', () => {
  const none = new Set<string>();
  it('nothing ticked', () => expect(applyBlockers([month({})], none, none, false)).toEqual(['Tick at least one month.']));
  it('a clean month is ready', () => expect(applyBlockers([month({})], new Set(['2026-05']), none, false)).toEqual([]));
  it('a partial month needs its own ack', () => {
    const ms = [month({ warnings: ['STARTS_AFTER_FIRST'] })];
    expect(applyBlockers(ms, new Set(['2026-05']), none, false)[0]).toMatch(/partial-month/);
    expect(applyBlockers(ms, new Set(['2026-05']), new Set(['2026-05']), false)).toEqual([]);
  });
  it('an older file needs the older ack', () => {
    const ms = [month({ warnings: ['OLDER_THAN_LAST_APPLIED'] })];
    expect(applyBlockers(ms, new Set(['2026-05']), none, false)).toHaveLength(1);
    expect(applyBlockers(ms, new Set(['2026-05']), none, true)).toEqual([]);
  });
  it('a blocked month is refused with its reason', () => {
    const ms = [month({ canApply: false, blockedReason: 'Month is CLOSED' })];
    expect(applyBlockers(ms, new Set(['2026-05']), none, false)[0]).toMatch(/Month is CLOSED/);
  });
});

describe('PRODUCT_COUNT formatting (plain integers: no ₹, no "cases", no decimals)', () => {
  it('formatKpiValue per measure', () => {
    expect(formatKpiValue(1234, 'PRODUCT_COUNT')).toBe('1,234');
    expect(formatKpiValue(7, 'PRODUCT_COUNT')).toBe('7');
    expect(formatKpiValue(0, 'PRODUCT_COUNT')).toBe('0');
    expect(formatKpiValue(12.5, 'QUANTITY')).toBe('12.5 cases'); // unchanged
    expect(formatKpiValue(12.5, 'AMOUNT')).toBe(formatRupees(12.5)); // unchanged
  });
  it('formatProducts: whole numbers, typographic minus for a negative delta', () => {
    expect(formatProducts(123456)).toBe('1,23,456');
    expect(formatProducts(-3)).toBe('−3');
    expect(formatSigned(-3, (n) => formatKpiValue(n, 'PRODUCT_COUNT'))).toBe('−3');
    expect(formatSigned(4, (n) => formatKpiValue(n, 'PRODUCT_COUNT'))).toBe('+4');
  });
  it('measureUnitLabel', () => {
    expect(measureUnitLabel('AMOUNT')).toBe('₹');
    expect(measureUnitLabel('QUANTITY')).toBe('Cases');
    expect(measureUnitLabel('PRODUCT_COUNT')).toBe('Products (lines)');
  });
});
