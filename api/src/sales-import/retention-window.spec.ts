import { currentMonthKey } from '../targets/targets.helpers';
import { shiftMonthKey } from './months/month-state';
import {
  SALES_RETENTION_V2_ENV,
  dayDataCutoffMonth,
  historyCutoffMonth,
  historyRetentionMessage,
  historyRetentionMonths,
  importRetentionDays,
  isBeyondDayDataRetention,
  isBeyondHistoryRetention,
  salesRetentionV2,
  v2WindowMonths,
} from './retention-window';

/** S1: the new retention rules are behind an explicit, default-OFF switch (SALES_RETENTION_V2=on). */
describe('retention window — SALES_RETENTION_V2 switch (default OFF = origin/develop behaviour)', () => {
  const KEYS = [SALES_RETENTION_V2_ENV, 'SALES_HISTORY_RETENTION_MONTHS'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
  afterEach(() => KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));
  const cur = currentMonthKey();

  it('switch OFF (unset / anything but "on"): 30-day import data, 10-year history — the old cutoffs exactly', () => {
    for (const v of [undefined, '', 'off', 'true', '1', 'yes', 'ON-ish']) {
      const env = v === undefined ? {} : { [SALES_RETENTION_V2_ENV]: v };
      expect(salesRetentionV2(env)).toBe(false);
      expect(importRetentionDays(env)).toBe(30);
    }
    expect(historyCutoffMonth()).toBe(shiftMonthKey(cur, -12 * 10)); // = origin/develop's shiftMonthKey(cur, -12 * 10)
    expect(isBeyondHistoryRetention(shiftMonthKey(cur, -4))).toBe(false);
    expect(isBeyondHistoryRetention(shiftMonthKey(cur, -120))).toBe(false);
    expect(isBeyondHistoryRetention(shiftMonthKey(cur, -121))).toBe(true);
    expect(historyRetentionMessage(shiftMonthKey(cur, -121))).toMatch(/kept for 10 years/);
    // the setting for the NEW window does not change the OFF behaviour
    process.env.SALES_HISTORY_RETENTION_MONTHS = '6';
    expect(historyCutoffMonth()).toBe(shiftMonthKey(cur, -120));
  });

  it('switch ON: 7-day import data, history = current month + 3 previous (computed from now)', () => {
    process.env[SALES_RETENTION_V2_ENV] = 'on';
    expect(salesRetentionV2()).toBe(true);
    expect(salesRetentionV2({ [SALES_RETENTION_V2_ENV]: ' ON ' })).toBe(true);
    expect(importRetentionDays()).toBe(7);
    expect(historyRetentionMonths()).toBe(4);
    expect(historyCutoffMonth()).toBe(shiftMonthKey(cur, -3));
    expect(isBeyondHistoryRetention(shiftMonthKey(cur, -3))).toBe(false);
    expect(isBeyondHistoryRetention(shiftMonthKey(cur, -4))).toBe(true);
    expect(isBeyondHistoryRetention(cur)).toBe(false);
    expect(historyCutoffMonth(shiftMonthKey(cur, 12))).toBe(shiftMonthKey(cur, 9)); // moves with the month
    expect(historyRetentionMessage(shiftMonthKey(cur, -4))).toMatch(/current month and the 3 months before it/);
  });

  it('day-level data follows the 4-month window whatever the switch (new tables)', () => {
    expect(dayDataCutoffMonth()).toBe(shiftMonthKey(cur, -3));
    expect(isBeyondDayDataRetention(shiftMonthKey(cur, -4))).toBe(true);
    expect(isBeyondDayDataRetention(shiftMonthKey(cur, -3))).toBe(false);
    process.env[SALES_RETENTION_V2_ENV] = 'on';
    expect(dayDataCutoffMonth()).toBe(shiftMonthKey(cur, -3));
  });

  it('the setting SALES_HISTORY_RETENTION_MONTHS sizes the NEW window (whole number 1..120; anything else → 4)', () => {
    expect(v2WindowMonths({ SALES_HISTORY_RETENTION_MONTHS: '6' })).toBe(6);
    expect(historyRetentionMonths({ [SALES_RETENTION_V2_ENV]: 'on', SALES_HISTORY_RETENTION_MONTHS: '6' })).toBe(6);
    for (const bad of ['0', '-1', '121', '4.5', 'abc', ' ']) expect(v2WindowMonths({ SALES_HISTORY_RETENTION_MONTHS: bad })).toBe(4);
  });
});
