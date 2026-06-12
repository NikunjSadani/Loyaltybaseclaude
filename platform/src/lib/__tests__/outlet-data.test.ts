/// <reference types="vitest/globals" />
/**
 * TDD — lib/outlet-data.ts
 *
 * Tests cover:
 *   A) seedOutletData      — idempotent seeder
 *   B) getOutletPrefillData — reads by outletId, returns Record<string,string>
 *   C) saveOutletPrefillData — upserts a single outlet's data
 */

import { seedOutletData, getOutletPrefillData, saveOutletPrefillData } from '../outlet-data';

// ── Helpers ────────────────────────────────────────────────────────────────────

function clearStorage() {
  localStorage.clear();
}

// ── A) seedOutletData ─────────────────────────────────────────────────────────

describe('seedOutletData', () => {
  beforeEach(clearStorage);

  it('populates localStorage when the key is absent', () => {
    seedOutletData();
    const data = getOutletPrefillData('o1');
    expect(typeof data).toBe('object');
  });

  it('is idempotent — calling twice does not duplicate data', () => {
    seedOutletData();
    const first = getOutletPrefillData('o1');
    seedOutletData();
    const second = getOutletPrefillData('o1');
    expect(first).toEqual(second);
  });

  it('does not overwrite existing data', () => {
    saveOutletPrefillData('o1', { custom_key: 'custom_value' });
    seedOutletData();
    const data = getOutletPrefillData('o1');
    expect(data['custom_key']).toBe('custom_value');
  });
});

// ── B) getOutletPrefillData ───────────────────────────────────────────────────

describe('getOutletPrefillData', () => {
  beforeEach(clearStorage);

  it('returns an empty object for an unknown outletId', () => {
    expect(getOutletPrefillData('nonexistent')).toEqual({});
  });

  it('returns the stored data for a known outletId after seed', () => {
    seedOutletData();
    const data = getOutletPrefillData('o1');
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });

  it('returns correct string values', () => {
    saveOutletPrefillData('test_outlet', { last_month_sales: '₹1,24,500', gstin: '27AAPFU0939F1ZV' });
    const data = getOutletPrefillData('test_outlet');
    expect(data['last_month_sales']).toBe('₹1,24,500');
    expect(data['gstin']).toBe('27AAPFU0939F1ZV');
  });
});

// ── C) saveOutletPrefillData ──────────────────────────────────────────────────

describe('saveOutletPrefillData', () => {
  beforeEach(clearStorage);

  it('persists data that can be retrieved', () => {
    saveOutletPrefillData('outlet_x', { score: '9.2', region: 'West' });
    const data = getOutletPrefillData('outlet_x');
    expect(data['score']).toBe('9.2');
    expect(data['region']).toBe('West');
  });

  it('overwrites data for the same outletId', () => {
    saveOutletPrefillData('outlet_y', { key: 'old' });
    saveOutletPrefillData('outlet_y', { key: 'new' });
    expect(getOutletPrefillData('outlet_y')['key']).toBe('new');
  });

  it('does not affect data for other outlets', () => {
    saveOutletPrefillData('a', { x: '1' });
    saveOutletPrefillData('b', { x: '2' });
    expect(getOutletPrefillData('a')['x']).toBe('1');
    expect(getOutletPrefillData('b')['x']).toBe('2');
  });

  it('handles empty data object gracefully', () => {
    saveOutletPrefillData('outlet_z', {});
    expect(getOutletPrefillData('outlet_z')).toEqual({});
  });
});
