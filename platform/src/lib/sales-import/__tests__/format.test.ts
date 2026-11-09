/// <reference types="vitest/globals" />
/**
 * Sales Import display helpers + apply gating.
 * Run: npx vitest run src/lib/sales-import/__tests__/format.test.ts
 */
import { describe, it, expect } from 'vitest';
import { applyBlockers, monthLabel, dayLabel, warningText, formatSigned, formatRupees, formatBytes } from '../format';
import type { MonthPreview } from '../types';

function month(over: Partial<MonthPreview>): MonthPreview {
  return {
    month: '2026-05', firstDate: '2026-05-01', lastDate: '2026-05-31', lines: 10, matchedOutlets: 2,
    unmatchedCustomers: 1, matchedAmountRupees: 100, matchedQuantity: 1, unmatchedAmountRupees: 5,
    unmatchedQuantity: 0, monthState: 'OPEN', canApply: true, warnings: [], zeroFillOutlets: 0, kpis: [],
    lastApplied: null, ...over,
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
