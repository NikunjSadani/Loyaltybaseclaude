/// <reference types="vitest/globals" />
/**
 * TDD — Sales last-upload timestamp
 *
 * A: formatLastUpdated() — pure date-formatting util
 * B: getLastSalesUploadDate / setLastSalesUploadDate — localStorage helpers
 * C: GET /api/sales/last-upload — API route (Prisma mocked)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatLastUpdated,
  getLastSalesUploadDate,
  setLastSalesUploadDate,
} from '@/lib/sales-upload-utils';

// ── A — formatLastUpdated() ─────────────────────────────────────────────────

describe('A — formatLastUpdated()', () => {
  it('A1: returns empty string for null', () => {
    expect(formatLastUpdated(null)).toBe('');
  });

  it('A2: formats a Date object as "Last updated on D Mon" (same year)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T10:00:00Z'));
    const result = formatLastUpdated(new Date('2026-06-03T14:22:00Z'));
    expect(result).toBe('Last updated on 3 Jun');
    vi.useRealTimers();
  });

  it('A3: formats an ISO string as "Last updated on D Mon" (same year)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T10:00:00Z'));
    const result = formatLastUpdated('2026-06-03T14:22:00Z');
    expect(result).toBe('Last updated on 3 Jun');
    vi.useRealTimers();
  });

  it('A4: includes year when upload was in a different year', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T10:00:00Z'));
    const result = formatLastUpdated(new Date('2025-12-01T00:00:00Z'));
    expect(result).toBe('Last updated on 1 Dec 2025');
    vi.useRealTimers();
  });

  it('A5: returns empty string for undefined', () => {
    expect(formatLastUpdated(undefined)).toBe('');
  });

  it('A6: no zero-padding on day (e.g. "7 Jun" not "07 Jun")', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T10:00:00Z'));
    const result = formatLastUpdated(new Date('2026-06-07T08:00:00Z'));
    expect(result).toBe('Last updated on 7 Jun');
    vi.useRealTimers();
  });
});

// ── B — localStorage helpers ────────────────────────────────────────────────

describe('B — getLastSalesUploadDate / setLastSalesUploadDate', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('B1: returns null when nothing has been stored', () => {
    expect(getLastSalesUploadDate()).toBeNull();
  });

  it('B2: stores and retrieves an ISO date string', () => {
    setLastSalesUploadDate('2026-06-03T14:22:00.000Z');
    expect(getLastSalesUploadDate()).toBe('2026-06-03T14:22:00.000Z');
  });

  it('B3: overwrites a previous value on subsequent calls', () => {
    setLastSalesUploadDate('2026-05-01T00:00:00.000Z');
    setLastSalesUploadDate('2026-06-03T14:22:00.000Z');
    expect(getLastSalesUploadDate()).toBe('2026-06-03T14:22:00.000Z');
  });

  it('B4: formatLastUpdated(getLastSalesUploadDate()) produces the expected label', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-07T10:00:00Z'));
    setLastSalesUploadDate('2026-06-03T14:22:00.000Z');
    const label = formatLastUpdated(getLastSalesUploadDate());
    expect(label).toBe('Last updated on 3 Jun');
    vi.useRealTimers();
  });
});
