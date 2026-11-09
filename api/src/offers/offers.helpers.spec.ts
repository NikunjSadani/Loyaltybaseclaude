// Unit tests for the pure offer-tile helpers (no Prisma).
// Run: npx jest src/offers/offers.helpers.spec.ts --no-coverage

import { BadRequestException } from '@nestjs/common';
import {
  assertNoNulls,
  computeProgress,
  dateToIstDay,
  istDayToDate,
  monthBounds,
  outletMatches,
  sortTiles,
  validateTileInput,
} from './offers.helpers';
import { OfferTileInput } from './offers.types';

const base: OfferTileInput = {
  group: 'TARGET_REWARD',
  valueType: 'POINTS',
  valueNumber: 35,
  valueText: null,
  unitLabel: 'per case',
  product: 'ADHO 50 ml',
  label: 'Earn on every case',
  details: 'Valid on billed cases only.',
  validFrom: '2026-11-01',
  validTo: '2026-11-30',
  sortOrder: 0,
  isActive: true,
  programNames: ['Gold'],
  outletTypeCodes: ['WHOLESALER'],
  zones: [],
  states: [],
  kpiCode: 'ADHO50',
};

describe('offers.helpers', () => {
  it('istDayToDate/dateToIstDay round-trip a calendar day (no TZ drift)', () => {
    expect(dateToIstDay(istDayToDate('2026-11-30'))).toBe('2026-11-30');
    expect(dateToIstDay(istDayToDate('2028-02-29'))).toBe('2028-02-29');
  });

  it('monthBounds gives first/last IST day', () => {
    expect(monthBounds('2026-02')).toEqual({ first: '2026-02-01', last: '2026-02-28' });
    expect(monthBounds('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
    expect(monthBounds('2026-12')).toEqual({ first: '2026-12-01', last: '2026-12-31' });
  });

  it('outletMatches: empty arrays = all; case/space-insensitive', () => {
    const tile = { programNames: ['Gold'], outletTypeCodes: [], zones: [], states: ['Maharashtra'] };
    expect(
      outletMatches(tile, { programName: ' gold ', outletTypeCode: 'SSS', zone: null, state: 'MAHARASHTRA' }),
    ).toBe(true);
    expect(
      outletMatches(tile, { programName: null, outletTypeCode: 'SSS', zone: null, state: 'Maharashtra' }),
    ).toBe(false);
    const all = { programNames: [], outletTypeCodes: [], zones: [], states: [] };
    expect(outletMatches(all, { programName: null, outletTypeCode: null, zone: null, state: null })).toBe(true);
  });

  it('computeProgress: target 0/absent → pct null, not unlocked; ≥100% → unlocked', () => {
    expect(computeProgress(null, 5)).toEqual({ target: null, achieved: 5, pct: null, unlocked: false });
    expect(computeProgress(0, 5)).toEqual({ target: 0, achieved: 5, pct: null, unlocked: false });
    expect(computeProgress(200, 120)).toEqual({ target: 200, achieved: 120, pct: 60, unlocked: false });
    expect(computeProgress(200, 200)).toMatchObject({ pct: 100, unlocked: true });
  });

  it('computeProgress: pct never reads 100 while locked; clamped to [0,100]; negative achieved → 0', () => {
    expect(computeProgress(200, 199)).toMatchObject({ pct: 99, unlocked: false }); // round() said 100
    expect(computeProgress(1000, 999.9)).toMatchObject({ pct: 99, unlocked: false });
    expect(computeProgress(3, 2)).toMatchObject({ pct: 66, unlocked: false }); // floor, not round
    expect(computeProgress(200, 260)).toEqual({ target: 200, achieved: 260, pct: 100, unlocked: true });
    expect(computeProgress(200, -50)).toEqual({ target: 200, achieved: 0, pct: 0, unlocked: false });
    expect(computeProgress(null, -50)).toEqual({ target: null, achieved: 0, pct: null, unlocked: false });
    expect(computeProgress(200, Number.NaN)).toMatchObject({ achieved: 0, pct: 0 });
  });

  describe('validateTileInput', () => {
    it('accepts a valid input and normalizes it', () => {
      const out = validateTileInput({ ...base, label: '  Earn  ', product: '   ', zones: [' North ', '', 'North'] });
      expect(out.label).toBe('Earn');
      expect(out.product).toBeNull();
      expect(out.zones).toEqual(['North']);
      expect(out.valueText).toBeNull();
      expect(out.valueNumber).toBe(35);
    });

    it('enforces value-type rules', () => {
      expect(() => validateTileInput({ ...base, valueType: 'PERCENT', valueNumber: 120 })).toThrow("Percent can't exceed 100");
      expect(() => validateTileInput({ ...base, valueType: 'TEXT', valueText: '' })).toThrow(BadRequestException);
      expect(
        validateTileInput({ ...base, valueType: 'TEXT', valueText: 'Free kit', valueNumber: 5 }).valueNumber,
      ).toBeNull();
      expect(() => validateTileInput({ ...base, validFrom: '2026-11-30', validTo: '2026-11-01' })).toThrow(
        'Valid to must be on or after Valid from',
      );
      expect(() => validateTileInput({ ...base, valueNumber: 1.234 })).toThrow(/2 decimal/);
      expect(() => validateTileInput({ ...base, valueNumber: -5 })).toThrow('Value must be greater than 0');
      expect(() => validateTileInput({ ...base, valueNumber: null })).toThrow('Value is required');
      expect(validateTileInput({ ...base, valueNumber: 1.1 }).valueNumber).toBe(1.1);
      expect(() => validateTileInput({ ...base, valueNumber: 0 })).toThrow('Value must be greater than 0');
      expect(() => validateTileInput({ ...base, valueNumber: null })).toThrow(BadRequestException);
      expect(() => validateTileInput({ ...base, valueNumber: 10_000_000 })).toThrow(BadRequestException);
      expect(() => validateTileInput({ ...base, valueType: 'TEXT', valueText: 'x'.repeat(13) })).toThrow(/12/);
    });

    it('enforces text length limits and non-empty label', () => {
      expect(() => validateTileInput({ ...base, label: '   ' })).toThrow('Headline is required');
      expect(() => validateTileInput({ ...base, label: 'x'.repeat(61) })).toThrow(/60/);
      expect(() => validateTileInput({ ...base, product: 'x'.repeat(41) })).toThrow(/40/);
      expect(() => validateTileInput({ ...base, unitLabel: 'x'.repeat(21) })).toThrow(/20/);
      expect(() => validateTileInput({ ...base, details: 'x'.repeat(1001) })).toThrow(/1000/);
    });

    it('rejects malformed or impossible dates', () => {
      expect(() => validateTileInput({ ...base, validFrom: '2026-02-30' })).toThrow(/Valid from/);
      expect(() => validateTileInput({ ...base, validTo: '30-11-2026' })).toThrow(/Valid to/);
    });

    it('caps the validity window at 366 days and years at 2020–2100', () => {
      // 366 inclusive days (leap year 2028) is fine; 367 is not.
      expect(validateTileInput({ ...base, validFrom: '2028-01-01', validTo: '2028-12-31' }).validTo).toBe('2028-12-31');
      expect(() => validateTileInput({ ...base, validFrom: '2028-01-01', validTo: '2029-01-01' })).toThrow(/366 days/);
      expect(() => validateTileInput({ ...base, validFrom: '2026-01-01', validTo: '2099-12-31' })).toThrow(/366 days/);
      expect(() => validateTileInput({ ...base, validFrom: '2019-12-31', validTo: '2020-01-05' })).toThrow(
        'Valid from must be between 2020 and 2100',
      );
      expect(() => validateTileInput({ ...base, validFrom: '2100-12-31', validTo: '2101-01-01' })).toThrow(
        'Valid to must be between 2020 and 2100',
      );
      expect(() => validateTileInput({ ...base, validFrom: '0001-01-01', validTo: '0001-01-02' })).toThrow(/2020/);
    });

    it('sortOrder must be a whole number in [0, 1,000,000]', () => {
      const msg = 'Sort order must be a whole number between 0 and 1,000,000';
      expect(validateTileInput({ ...base, sortOrder: 1_000_000 }).sortOrder).toBe(1_000_000);
      expect(() => validateTileInput({ ...base, sortOrder: -1 })).toThrow(msg);
      expect(() => validateTileInput({ ...base, sortOrder: 1_000_001 })).toThrow(msg);
      expect(() => validateTileInput({ ...base, sortOrder: 1.5 })).toThrow(msg);
    });

    it('assertNoNulls refuses explicit null on non-nullable fields only', () => {
      expect(() => assertNoNulls({ isActive: null })).toThrow("Published can't be empty");
      expect(() => assertNoNulls({ sortOrder: null })).toThrow("Sort order can't be empty");
      expect(() => assertNoNulls({ zones: null })).toThrow(/empty list/);
      expect(() => assertNoNulls({ kpiCode: null, product: null, details: null, valueNumber: null })).not.toThrow();
      expect(() => assertNoNulls({ zones: [], isActive: false })).not.toThrow();
      expect(() => assertNoNulls(undefined)).not.toThrow();
    });

    it('enforces array limits', () => {
      expect(() => validateTileInput({ ...base, states: Array.from({ length: 51 }, (_, i) => `s${i}`) })).toThrow(/50/);
      expect(() => validateTileInput({ ...base, states: ['x'.repeat(81)] })).toThrow(/80/);
    });

    it('defaults sortOrder/isActive/arrays/kpiCode', () => {
      const out = validateTileInput({
        group: 'EXTRA_SCHEME', valueType: 'RUPEES', valueNumber: 1500, label: 'Bonus',
        validFrom: '2026-11-01', validTo: '2026-11-30',
      });
      expect(out).toMatchObject({
        sortOrder: 0, isActive: true, programNames: [], outletTypeCodes: [], zones: [], states: [],
        kpiCode: null, unitLabel: null, product: null, details: null,
      });
    });
  });

  it('sortTiles: TARGET_REWARD first, then sortOrder, then createdAt', () => {
    const t = (id: string, group: 'TARGET_REWARD' | 'EXTRA_SCHEME', sortOrder: number, created: string) => ({
      id, group, sortOrder, createdAt: new Date(created),
    });
    const sorted = sortTiles([
      t('e1', 'EXTRA_SCHEME', 0, '2026-01-01'),
      t('t2', 'TARGET_REWARD', 1, '2026-01-01'),
      t('t1b', 'TARGET_REWARD', 0, '2026-01-02'),
      t('t1a', 'TARGET_REWARD', 0, '2026-01-01'),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(['t1a', 't1b', 't2', 'e1']);
  });
});
