/**
 * Unit tests for TdsStatutoryConfigService + validateStatutoryEntries.
 * Covers: resolver picks the right entry by FY (latest <= target); fall-back to DEFAULT when the
 * setting is absent / empty / malformed / out-of-bounds / no-entry-qualifies / bad-FY-label; the
 * ×100 rupee→paise conversion; and the strict write-path validation (bad FY label, duplicate FY,
 * pct>95, negative threshold, non-integer, empty).
 * Run: npx jest src/tds/tds-statutory.config.service.spec.ts
 */
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  TdsStatutoryConfigService,
  validateStatutoryEntries,
  StoredStatutoryEntry,
} from './tds-statutory.config.service';
import { DEFAULT_RESOLVED_TDS_STATUTORY, toTdsRate, fyOfToday } from './tds.helpers';

// FY labels relative to "now" (date-relative so the tests never rot): a clearly-CLOSED past FY,
// the current FY, and a clearly-future FY.
const CUR_FY = fyOfToday().fyLabel;
const CUR_START = parseInt(CUR_FY.slice(0, 4), 10);
const fyLabelFor = (start: number) => `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
const PAST_FY = fyLabelFor(CUR_START - 5);
const FUTURE_FY = fyLabelFor(CUR_START + 5);

// ─── Fixtures ────────────────────────────────────────────────────────────────

const entry = (over: Partial<StoredStatutoryEntry> & { effectiveFromFy: string }): StoredStatutoryEntry => ({
  r194rWithPanPct: 10,
  r194rNoPanPct: 20,
  c194cIndividualPct: 1,
  c194cOtherPct: 2,
  c194cNoPanPct: 20,
  thr194cSingleRupees: 30000,
  thr194cFyRupees: 100000,
  thr194rFyRupees: 20000,
  ...over,
});

function makeService(settingValue: unknown | undefined): {
  service: TdsStatutoryConfigService;
  findUnique: jest.Mock;
} {
  const findUnique = jest.fn().mockResolvedValue(
    settingValue === undefined ? null : { settingValue },
  );
  const prisma = { programSetting: { findUnique } } as unknown as PrismaService;
  return { service: new TdsStatutoryConfigService(prisma), findUnique };
}

// ─── validateStatutoryEntries ────────────────────────────────────────────────

describe('validateStatutoryEntries', () => {
  it('accepts a well-formed non-empty list and returns normalised entries', () => {
    const out = validateStatutoryEntries([entry({ effectiveFromFy: '2026-27' })]);
    expect(out).toHaveLength(1);
    expect(out[0].effectiveFromFy).toBe('2026-27');
  });

  it('rejects an empty list', () => {
    expect(() => validateStatutoryEntries([])).toThrow(BadRequestException);
  });

  it('rejects a non-array', () => {
    expect(() => validateStatutoryEntries({} as unknown)).toThrow(BadRequestException);
  });

  it('rejects a bad FY label', () => {
    expect(() => validateStatutoryEntries([entry({ effectiveFromFy: '2026' })])).toThrow(/effectiveFromFy/);
    expect(() => validateStatutoryEntries([entry({ effectiveFromFy: '26-27' })])).toThrow(/effectiveFromFy/);
  });

  it('rejects a duplicate FY label', () => {
    expect(() =>
      validateStatutoryEntries([entry({ effectiveFromFy: '2026-27' }), entry({ effectiveFromFy: '2026-27' })]),
    ).toThrow(/duplicated/);
  });

  it('rejects a rate pct > 95', () => {
    expect(() => validateStatutoryEntries([entry({ effectiveFromFy: '2026-27', r194rWithPanPct: 96 })])).toThrow(
      /r194rWithPanPct/,
    );
  });

  it('rejects a negative rate pct', () => {
    expect(() => validateStatutoryEntries([entry({ effectiveFromFy: '2026-27', c194cOtherPct: -1 })])).toThrow(
      /c194cOtherPct/,
    );
  });

  it('rejects a non-integer rate pct', () => {
    expect(() => validateStatutoryEntries([entry({ effectiveFromFy: '2026-27', r194rNoPanPct: 20.5 })])).toThrow(
      /r194rNoPanPct/,
    );
  });

  it('rejects a negative threshold', () => {
    expect(() => validateStatutoryEntries([entry({ effectiveFromFy: '2026-27', thr194rFyRupees: -1 })])).toThrow(
      /thr194rFyRupees/,
    );
  });

  it('rejects a non-integer threshold', () => {
    expect(() => validateStatutoryEntries([entry({ effectiveFromFy: '2026-27', thr194cFyRupees: 100000.5 })])).toThrow(
      /thr194cFyRupees/,
    );
  });

  it('accepts pct at the 0 and 95 bounds', () => {
    expect(() =>
      validateStatutoryEntries([entry({ effectiveFromFy: '2026-27', r194rWithPanPct: 0, r194rNoPanPct: 95 })]),
    ).not.toThrow();
  });
});

// ─── getForFy: entry selection + fall-back ───────────────────────────────────

describe('TdsStatutoryConfigService.getForFy', () => {
  it('returns DEFAULT when the setting is absent', async () => {
    const { service } = makeService(undefined);
    await expect(service.getForFy('2026-27')).resolves.toEqual(DEFAULT_RESOLVED_TDS_STATUTORY);
  });

  it('returns DEFAULT when entries is an empty array', async () => {
    const { service } = makeService({ entries: [] });
    await expect(service.getForFy('2026-27')).resolves.toEqual(DEFAULT_RESOLVED_TDS_STATUTORY);
  });

  it('returns DEFAULT when the stored value is malformed (no entries array)', async () => {
    const { service } = makeService({ nope: true });
    await expect(service.getForFy('2026-27')).resolves.toEqual(DEFAULT_RESOLVED_TDS_STATUTORY);
  });

  it('returns DEFAULT when any entry is out of bounds (fail-safe, whole config)', async () => {
    const { service } = makeService({
      entries: [entry({ effectiveFromFy: '2026-27' }), entry({ effectiveFromFy: '2027-28', r194rWithPanPct: 999 })],
    });
    await expect(service.getForFy('2027-28')).resolves.toEqual(DEFAULT_RESOLVED_TDS_STATUTORY);
  });

  it('returns DEFAULT when no entry qualifies (all effectiveFromFy are later than target)', async () => {
    const { service } = makeService({ entries: [entry({ effectiveFromFy: '2027-28' })] });
    await expect(service.getForFy('2026-27')).resolves.toEqual(DEFAULT_RESOLVED_TDS_STATUTORY);
  });

  it('returns DEFAULT for a malformed target FY label', async () => {
    const { service } = makeService({ entries: [entry({ effectiveFromFy: '2020-21' })] });
    await expect(service.getForFy('nonsense')).resolves.toEqual(DEFAULT_RESOLVED_TDS_STATUTORY);
  });

  it('picks the LATEST effectiveFromFy that is <= target', async () => {
    const { service } = makeService({
      entries: [
        entry({ effectiveFromFy: '2024-25', r194rWithPanPct: 5 }),
        entry({ effectiveFromFy: '2026-27', r194rWithPanPct: 12 }),
        entry({ effectiveFromFy: '2028-29', r194rWithPanPct: 15 }),
      ],
    });
    // Target 2027-28 → latest <= is 2026-27 (pct 12 → 12/88).
    const r = await service.getForFy('2027-28');
    expect(r.r194rWithPan).toEqual(toTdsRate(12));
  });

  it('picks the exact entry when target equals an effectiveFromFy', async () => {
    const { service } = makeService({
      entries: [
        entry({ effectiveFromFy: '2024-25', r194rWithPanPct: 5 }),
        entry({ effectiveFromFy: '2026-27', r194rWithPanPct: 12 }),
      ],
    });
    const r = await service.getForFy('2026-27');
    expect(r.r194rWithPan).toEqual(toTdsRate(12));
  });

  it('converts threshold rupees ×100 to paise', async () => {
    const { service } = makeService({
      entries: [
        entry({
          effectiveFromFy: '2026-27',
          thr194cSingleRupees: 40000,
          thr194cFyRupees: 150000,
          thr194rFyRupees: 25000,
        }),
      ],
    });
    const r = await service.getForFy('2026-27');
    expect(r.thr194cSinglePaise).toBe(4_000_000n);
    expect(r.thr194cFyPaise).toBe(15_000_000n);
    expect(r.thr194rFyPaise).toBe(2_500_000n);
  });

  it('resolves rates from percentages into {num, den} fractions', async () => {
    const { service } = makeService({
      entries: [
        entry({
          effectiveFromFy: '2026-27',
          r194rWithPanPct: 10,
          r194rNoPanPct: 20,
          c194cIndividualPct: 1,
          c194cOtherPct: 2,
          c194cNoPanPct: 20,
        }),
      ],
    });
    const r = await service.getForFy('2026-27');
    expect(r.r194rWithPan).toEqual({ num: 10, den: 90 });
    expect(r.r194rNoPan).toEqual({ num: 20, den: 80 });
    expect(r.c194cIndividual).toEqual({ num: 1, den: 99 });
    expect(r.c194cOther).toEqual({ num: 2, den: 98 });
    expect(r.c194cNoPan).toEqual({ num: 20, den: 80 });
  });

  it('caches the read and invalidate() forces a re-read', async () => {
    const { service, findUnique } = makeService({ entries: [entry({ effectiveFromFy: '2026-27' })] });
    await service.getForFy('2026-27');
    await service.getForFy('2026-27');
    expect(findUnique).toHaveBeenCalledTimes(1); // second call served from cache
    service.invalidate();
    await service.getForFy('2026-27');
    expect(findUnique).toHaveBeenCalledTimes(2); // re-read after invalidate
  });
});

// ─── getAll ──────────────────────────────────────────────────────────────────

describe('TdsStatutoryConfigService.getAll', () => {
  it('returns [] entries + defaults + a JSON-safe resolved-for-current-FY when absent', async () => {
    const { service } = makeService(undefined);
    const all = await service.getAll();
    expect(all.entries).toEqual([]);
    expect(all.defaults.thr194cSingleRupees).toBe(30000);
    expect(all.defaults.thr194rFyRupees).toBe(20000);
    // Resolved thresholds are serialised as strings (BigInt-safe for JSON).
    expect(typeof all.resolvedForCurrentFy.thr194cSinglePaise).toBe('string');
    expect(all.resolvedForCurrentFy.thr194cSinglePaise).toBe('3000000');
    expect(all.resolvedForCurrentFy.r194rWithPan).toEqual({ num: 10, den: 90 });
    expect(all.currentFyLabel).toMatch(/^\d{4}-\d{2}$/);
  });

  it('surfaces the stored entries verbatim (rupees/pct)', async () => {
    const stored = entry({ effectiveFromFy: '2020-21', r194rWithPanPct: 7 });
    const { service } = makeService({ entries: [stored] });
    const all = await service.getAll();
    expect(all.entries).toHaveLength(1);
    expect(all.entries[0].r194rWithPanPct).toBe(7);
  });
});

// ─── threshold must be > 0 (money footgun guard) ─────────────────────────────

describe('validateStatutoryEntries — threshold lower bound', () => {
  it('rejects a 0 threshold (would withhold on every payout)', () => {
    expect(() =>
      validateStatutoryEntries([entry({ effectiveFromFy: CUR_FY, thr194rFyRupees: 0 })]),
    ).toThrow(/greater than 0/);
  });
  it('accepts a threshold of 1 rupee', () => {
    const out = validateStatutoryEntries([entry({ effectiveFromFy: CUR_FY, thr194cSingleRupees: 1 })]);
    expect(out[0].thr194cSingleRupees).toBe(1);
  });
});

// ─── closed-FY immutability (WRITE-path guard) ───────────────────────────────

describe('TdsStatutoryConfigService.assertClosedFyImmutable', () => {
  it('allows adding the current and a future FY when nothing is stored', async () => {
    const { service } = makeService(undefined);
    await expect(
      service.assertClosedFyImmutable([entry({ effectiveFromFy: CUR_FY }), entry({ effectiveFromFy: FUTURE_FY })]),
    ).resolves.toBeUndefined();
  });

  it('rejects ADDING a closed (past) FY', async () => {
    const { service } = makeService(undefined);
    await expect(
      service.assertClosedFyImmutable([entry({ effectiveFromFy: PAST_FY })]),
    ).rejects.toThrow(/closed financial year/i);
  });

  it('rejects MODIFYING a stored closed FY', async () => {
    const stored = entry({ effectiveFromFy: PAST_FY, c194cOtherPct: 2 });
    const { service } = makeService({ entries: [stored] });
    await expect(
      service.assertClosedFyImmutable([entry({ effectiveFromFy: PAST_FY, c194cOtherPct: 5 })]),
    ).rejects.toThrow(/closed financial year/i);
  });

  it('rejects REMOVING a stored closed FY', async () => {
    const { service } = makeService({ entries: [entry({ effectiveFromFy: PAST_FY })] });
    await expect(
      service.assertClosedFyImmutable([entry({ effectiveFromFy: CUR_FY })]),
    ).rejects.toThrow(/closed financial year/i);
  });

  it('allows an UNCHANGED closed FY alongside a current-FY edit', async () => {
    const past = entry({ effectiveFromFy: PAST_FY });
    const { service } = makeService({ entries: [past] });
    await expect(
      service.assertClosedFyImmutable([past, entry({ effectiveFromFy: CUR_FY, c194cOtherPct: 3 })]),
    ).resolves.toBeUndefined();
  });
});
