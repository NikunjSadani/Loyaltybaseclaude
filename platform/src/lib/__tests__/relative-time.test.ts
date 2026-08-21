/// <reference types="vitest/globals" />
/**
 * formatRelativeTime — deterministic by injecting the reference `now`
 * (never hardcode a fixed clock; compute offsets relative to a fixed base).
 */
import { describe, it, expect } from 'vitest';
import { formatRelativeTime, formatDate } from '@/lib/utils';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const SEC = 1000, MIN = 60 * SEC, HR = 60 * MIN, DAY = 24 * HR, WK = 7 * DAY;

describe('formatRelativeTime', () => {
  it('shows "just now" for very recent timestamps', () => {
    expect(formatRelativeTime(ago(5 * SEC), NOW)).toBe('just now');
  });

  it('formats minutes', () => {
    expect(formatRelativeTime(ago(5 * MIN), NOW)).toBe('5 min ago');
  });

  it('formats hours with pluralisation', () => {
    expect(formatRelativeTime(ago(1 * HR), NOW)).toBe('1 hr ago');
    expect(formatRelativeTime(ago(3 * HR), NOW)).toBe('3 hrs ago');
  });

  it('formats days with pluralisation', () => {
    expect(formatRelativeTime(ago(1 * DAY), NOW)).toBe('1 day ago');
    expect(formatRelativeTime(ago(2 * DAY), NOW)).toBe('2 days ago');
  });

  it('formats weeks', () => {
    expect(formatRelativeTime(ago(2 * WK), NOW)).toBe('2 wks ago');
  });

  it('falls back to an absolute date once older than ~5 weeks', () => {
    const old = ago(6 * WK);
    expect(formatRelativeTime(old, NOW)).toBe(formatDate(old));
  });

  it('reads future / clock-skewed timestamps as "just now"', () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + 3 * MIN).toISOString(), NOW)).toBe('just now');
  });

  it('returns empty string for an invalid date', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});
