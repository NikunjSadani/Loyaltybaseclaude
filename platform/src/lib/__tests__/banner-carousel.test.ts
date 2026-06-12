/// <reference types="vitest/globals" />
/**
 * TDD — Banner carousel
 *
 * A: getActiveBanners() — multi-banner support
 * B: priority ordering
 * C: newBanner() default priority
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveBanners, getActiveBanners, newBanner,
  type Banner,
} from '@/lib/banner';

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
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('A — getActiveBanners()', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('A1: returns empty array when no banners stored', () => {
    expect(getActiveBanners()).toEqual([]);
  });

  it('A2: returns empty array when all banners are inactive', () => {
    saveBanners([makeBanner({ active: false }), makeBanner({ active: false })]);
    expect(getActiveBanners()).toEqual([]);
  });

  it('A3: returns only active banners', () => {
    const active1 = makeBanner({ active: true,  title: 'A' });
    const inactive = makeBanner({ active: false, title: 'B' });
    const active2  = makeBanner({ active: true,  title: 'C' });
    saveBanners([active1, inactive, active2]);
    const result = getActiveBanners();
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.title)).toContain('A');
    expect(result.map((b) => b.title)).toContain('C');
  });

  it('A4: returns ALL active banners, not just the first', () => {
    saveBanners([
      makeBanner({ active: true, title: 'One'   }),
      makeBanner({ active: true, title: 'Two'   }),
      makeBanner({ active: true, title: 'Three' }),
    ]);
    expect(getActiveBanners()).toHaveLength(3);
  });
});

describe('B — priority ordering', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('B1: returns banners sorted by priority ascending (0 → 1 → 2)', () => {
    const low  = makeBanner({ priority: 2, title: 'Low'    });
    const high = makeBanner({ priority: 0, title: 'High'   });
    const mid  = makeBanner({ priority: 1, title: 'Medium' });
    saveBanners([low, high, mid]);
    const result = getActiveBanners();
    expect(result[0].title).toBe('High');
    expect(result[1].title).toBe('Medium');
    expect(result[2].title).toBe('Low');
  });

  it('B2: banners with same priority preserve insertion order', () => {
    const a = makeBanner({ priority: 1, title: 'A' });
    const b = makeBanner({ priority: 1, title: 'B' });
    saveBanners([a, b]);
    const result = getActiveBanners();
    expect(result[0].title).toBe('A');
    expect(result[1].title).toBe('B');
  });

  it('B3: inactive banners are excluded even if they have high priority', () => {
    const inactive = makeBanner({ priority: 0, active: false, title: 'Should be hidden' });
    const active   = makeBanner({ priority: 5, active: true,  title: 'Should be shown'  });
    saveBanners([inactive, active]);
    const result = getActiveBanners();
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Should be shown');
  });
});

describe('C — newBanner() defaults', () => {
  it('C1: newBanner() includes priority field defaulting to 0', () => {
    const b = newBanner();
    expect(b).toHaveProperty('priority');
    expect(b.priority).toBe(0);
  });

  it('C2: newBanner() is inactive by default', () => {
    expect(newBanner().active).toBe(false);
  });
});
