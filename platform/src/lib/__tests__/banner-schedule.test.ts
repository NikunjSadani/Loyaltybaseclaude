/// <reference types="vitest/globals" />
/**
 * TDD — Banner scheduling (start / end date)
 *
 * A: Banner interface carries startDate / endDate
 * B: getActiveBanners() respects date range — only serves in-window banners
 * C: newBanner() defaults
 * D: edge cases (no dates set, only one bound set)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { saveBanners, getActiveBanners, newBanner, type Banner } from '@/lib/banner';

const NOW = new Date('2026-06-07T12:00:00Z');

// Pin "now" so tests don't depend on wall-clock
function freezeDate(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

function makeBanner(overrides: Partial<Banner> = {}): Banner {
  return {
    id: crypto.randomUUID(),
    active: true,
    type: 'text',
    title: 'Test',
    body: 'Body',
    ctaLabel: '',
    ctaUrl: '',
    videoUrl: '',
    bgColor: 'navy',
    audience: 'ALL',
    priority: 0,
    startDate: '',
    endDate: '',
    showInSalesApp: false,
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('A — Banner interface has startDate / endDate', () => {
  it('A1: newBanner() has startDate field (empty string by default)', () => {
    const b = newBanner();
    expect(b).toHaveProperty('startDate');
    expect(b.startDate).toBe('');
  });

  it('A2: newBanner() has endDate field (empty string by default)', () => {
    const b = newBanner();
    expect(b).toHaveProperty('endDate');
    expect(b.endDate).toBe('');
  });
});

describe('B — getActiveBanners() respects scheduling', () => {
  beforeEach(() => {
    localStorage.clear();
    freezeDate('2026-06-07T12:00:00Z');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('B1: shows banner when no start/end dates set (always visible when active)', () => {
    saveBanners([makeBanner({ startDate: '', endDate: '' })]);
    expect(getActiveBanners()).toHaveLength(1);
  });

  it('B2: shows banner when current date is within start–end range', () => {
    saveBanners([makeBanner({ startDate: '2026-06-01', endDate: '2026-06-30' })]);
    expect(getActiveBanners()).toHaveLength(1);
  });

  it('B3: hides banner when current date is before startDate', () => {
    saveBanners([makeBanner({ startDate: '2026-06-10', endDate: '2026-06-30' })]);
    expect(getActiveBanners()).toHaveLength(0);
  });

  it('B4: hides banner when current date is after endDate', () => {
    saveBanners([makeBanner({ startDate: '2026-06-01', endDate: '2026-06-06' })]);
    expect(getActiveBanners()).toHaveLength(0);
  });

  it('B5: shows banner on the exact startDate (inclusive)', () => {
    saveBanners([makeBanner({ startDate: '2026-06-07', endDate: '2026-06-30' })]);
    expect(getActiveBanners()).toHaveLength(1);
  });

  it('B6: shows banner on the exact endDate (inclusive)', () => {
    saveBanners([makeBanner({ startDate: '2026-06-01', endDate: '2026-06-07' })]);
    expect(getActiveBanners()).toHaveLength(1);
  });

  it('B7: only startDate set — shows when today >= startDate', () => {
    saveBanners([makeBanner({ startDate: '2026-06-01', endDate: '' })]);
    expect(getActiveBanners()).toHaveLength(1);
  });

  it('B8: only startDate set — hides when today < startDate', () => {
    saveBanners([makeBanner({ startDate: '2026-06-10', endDate: '' })]);
    expect(getActiveBanners()).toHaveLength(0);
  });

  it('B9: only endDate set — shows when today <= endDate', () => {
    saveBanners([makeBanner({ startDate: '', endDate: '2026-06-30' })]);
    expect(getActiveBanners()).toHaveLength(1);
  });

  it('B10: only endDate set — hides when today > endDate', () => {
    saveBanners([makeBanner({ startDate: '', endDate: '2026-06-06' })]);
    expect(getActiveBanners()).toHaveLength(0);
  });

  it('B11: inactive banner is hidden even if within date range', () => {
    saveBanners([makeBanner({ active: false, startDate: '2026-06-01', endDate: '2026-06-30' })]);
    expect(getActiveBanners()).toHaveLength(0);
  });

  it('B12: mix — only in-window active banners returned', () => {
    saveBanners([
      makeBanner({ title: 'Live',    startDate: '2026-06-01', endDate: '2026-06-30', priority: 0 }),
      makeBanner({ title: 'Future',  startDate: '2026-06-10', endDate: '2026-06-30', priority: 1 }),
      makeBanner({ title: 'Expired', startDate: '2026-06-01', endDate: '2026-06-05', priority: 2 }),
    ]);
    const result = getActiveBanners();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Live');
  });
});

describe('C — priority ordering still works with scheduled banners', () => {
  beforeEach(() => {
    localStorage.clear();
    freezeDate('2026-06-07T12:00:00Z');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('C1: in-window banners sorted by priority', () => {
    saveBanners([
      makeBanner({ title: 'P2', priority: 2, startDate: '2026-06-01', endDate: '2026-06-30' }),
      makeBanner({ title: 'P0', priority: 0, startDate: '2026-06-01', endDate: '2026-06-30' }),
      makeBanner({ title: 'P1', priority: 1, startDate: '2026-06-01', endDate: '2026-06-30' }),
    ]);
    const result = getActiveBanners();
    expect(result.map((b) => b.title)).toEqual(['P0', 'P1', 'P2']);
  });
});
