/**
 * Unit tests for tds.helpers.ts — pure calc, no I/O.
 * Run: npx jest src/tds/tds.helpers.spec.ts
 */
import {
  roundToRupeePaise,
  grossUpTdsPaise,
  rate194R,
  rate194C,
  financialYear,
  fyOfToday,
  fyFromLabel,
} from './tds.helpers';

// ─── roundToRupeePaise ───────────────────────────────────────────────────────

describe('roundToRupeePaise', () => {
  it('rounds 0 to 0', () => expect(roundToRupeePaise(0n)).toBe(0n));
  it('rounds 49 paise down to 0', () => expect(roundToRupeePaise(49n)).toBe(0n));
  it('rounds 50 paise up to 100', () => expect(roundToRupeePaise(50n)).toBe(100n));
  it('rounds 99 paise up to 100', () => expect(roundToRupeePaise(99n)).toBe(100n));
  it('rounds 100 paise to 100', () => expect(roundToRupeePaise(100n)).toBe(100n));
  it('rounds 149 paise to 100', () => expect(roundToRupeePaise(149n)).toBe(100n));
  it('rounds 150 paise up to 200', () => expect(roundToRupeePaise(150n)).toBe(200n));
  it('rounds 2500000 (exact rupees) unchanged', () => expect(roundToRupeePaise(2500000n)).toBe(2500000n));
  it('handles a large even number of rupees', () => expect(roundToRupeePaise(100000000n)).toBe(100000000n));
});

// ─── grossUpTdsPaise ─────────────────────────────────────────────────────────

describe('grossUpTdsPaise', () => {
  // 194R PAN: 10/90
  it('194R PAN: ₹1,000 (100000p) → TDS = 100000×10/90 = 11111.1p → rounded ₹111 = 11100p', () => {
    // 100000 * 10 / 90 = 11111.11... → round to nearest 100 → 11100
    expect(grossUpTdsPaise(100000n, { num: 10, den: 90 })).toBe(11100n);
  });

  it('194R PAN: ₹20,001 (2000100p) → TDS = 2000100×10/90 = 222233.3p → ₹2222 = 222200p', () => {
    // 2000100 * 10 = 20001000; 20001000 / 90 = 222233.3... → round to 222200
    const raw = 2000100n * 10n / 90n; // 222233n (floor)
    // roundToRupee(222233) → (222233+50)/100*100 = 222283/100*100 = 2222*100 = 222200
    expect(grossUpTdsPaise(2000100n, { num: 10, den: 90 })).toBe(222200n);
  });

  it('194R no-PAN: ₹10,000 (1000000p) → TDS = 1000000×20/80 = 250000p = ₹2500', () => {
    expect(grossUpTdsPaise(1000000n, { num: 20, den: 80 })).toBe(250000n);
  });

  it('194C indiv/HUF: ₹50,000 (5000000p) → TDS = 5000000×1/99 = 50505.05p → ₹505 = 50500p', () => {
    // 5000000 * 1 / 99 = 50505.05... → round → (50505+50)/100*100 = 50555/100*100 = 505*100 = 50500
    expect(grossUpTdsPaise(5000000n, { num: 1, den: 99 })).toBe(50500n);
  });

  it('194C others: ₹50,000 (5000000p) → TDS = 5000000×2/98 = 102040.8p → ₹1020 = 102000p', () => {
    // 5000000 * 2 / 98 = 102040.8... → round → (102040+50)/100*100 = 102090/100*100 = 1020*100 = 102000
    expect(grossUpTdsPaise(5000000n, { num: 2, den: 98 })).toBe(102000n);
  });

  it('194C no-PAN: ₹30,000 (3000000p) → TDS = 3000000×20/80 = 750000p = ₹7500', () => {
    expect(grossUpTdsPaise(3000000n, { num: 20, den: 80 })).toBe(750000n);
  });

  it('base = 0 → TDS = 0', () => {
    expect(grossUpTdsPaise(0n, { num: 10, den: 90 })).toBe(0n);
  });

  // Retroactive threshold: ₹20,001 triggers TDS on the WHOLE amount
  it('exact gross-up of ₹20,001 (PAN) = 11111.1... paise → rounds to nearest 100', () => {
    const base = 2000100n; // ₹20,001
    const result = grossUpTdsPaise(base, { num: 10, den: 90 });
    // 2000100*10=20001000; 20001000/90=222233(floor); round=(222233+50)/100*100=2222*100=222200
    expect(result).toBe(222200n);
    // Confirm it's a multiple of 100 (whole rupees)
    expect(result % 100n).toBe(0n);
  });
});

// ─── rate194R ────────────────────────────────────────────────────────────────

describe('rate194R', () => {
  it('PAN holder → 10/90', () => expect(rate194R(true)).toEqual({ num: 10, den: 90 }));
  it('no PAN     → 20/80', () => expect(rate194R(false)).toEqual({ num: 20, den: 80 }));
});

// ─── rate194C ────────────────────────────────────────────────────────────────

describe('rate194C', () => {
  it('no PAN                 → 20/80', () => expect(rate194C(false, 'INDIVIDUAL')).toEqual({ num: 20, den: 80 }));
  it('INDIVIDUAL             → 1/99',  () => expect(rate194C(true, 'INDIVIDUAL')).toEqual({ num: 1, den: 99 }));
  it('HUF                   → 1/99',  () => expect(rate194C(true, 'HUF')).toEqual({ num: 1, den: 99 }));
  it('COMPANY                → 2/98',  () => expect(rate194C(true, 'COMPANY')).toEqual({ num: 2, den: 98 }));
  it('FIRM                   → 2/98',  () => expect(rate194C(true, 'FIRM')).toEqual({ num: 2, den: 98 }));
  it('LLP                    → 2/98',  () => expect(rate194C(true, 'LLP')).toEqual({ num: 2, den: 98 }));
  it('OTHERS                 → 2/98',  () => expect(rate194C(true, 'OTHERS')).toEqual({ num: 2, den: 98 }));
  it('null entityType        → 2/98',  () => expect(rate194C(true, null)).toEqual({ num: 2, den: 98 }));
  it('undefined entityType   → 2/98',  () => expect(rate194C(true, undefined)).toEqual({ num: 2, den: 98 }));
});

// ─── financialYear / fyOfToday / fyFromLabel ─────────────────────────────────

describe('financialYear', () => {
  // FY boundaries are anchored to 1 Apr 00:00 IST = 31 Mar 18:30 UTC.
  const FY_2025_START_UTC = new Date('2025-03-31T18:30:00Z'); // 1 Apr 2025 00:00 IST
  const FY_2026_START_UTC = new Date('2026-03-31T18:30:00Z'); // 1 Apr 2026 00:00 IST
  const FY_2027_START_UTC = new Date('2027-03-31T18:30:00Z'); // 1 Apr 2027 00:00 IST

  it('1 Apr 2025 05:30 IST → FY 2025-26 with IST-anchored start/end', () => {
    const fy = financialYear(new Date('2025-04-01T00:00:00Z')); // = 1 Apr 05:30 IST
    expect(fy.fyLabel).toBe('2025-26');
    expect(fy.start).toEqual(FY_2025_START_UTC);
    expect(fy.endExclusive).toEqual(FY_2026_START_UTC);
  });

  it('31 Mar 2026 23:59:59 UTC (= 1 Apr 05:29 IST) → FY 2026-27 (past the IST boundary)', () => {
    // IST-anchored: FY 2025-26 ends 31 Mar 2026 23:59:59 IST. 23:59:59 UTC is already
    // 1 Apr 05:29 IST, so it belongs to the NEW FY (this was the pre-IST UTC bug).
    const fy = financialYear(new Date('2026-03-31T23:59:59Z'));
    expect(fy.fyLabel).toBe('2026-27');
  });

  it('1 Apr 2026 05:30 IST → FY 2026-27 (boundary flip)', () => {
    const fy = financialYear(new Date('2026-04-01T00:00:00Z'));
    expect(fy.fyLabel).toBe('2026-27');
    expect(fy.start).toEqual(FY_2026_START_UTC);
    expect(fy.endExclusive).toEqual(FY_2027_START_UTC);
  });

  it('1 Jan 2026 → FY 2025-26 (January is still in prior FY)', () => {
    const fy = financialYear(new Date('2026-01-01T00:00:00Z'));
    expect(fy.fyLabel).toBe('2025-26');
  });

  it('31 Mar 2026 → FY 2025-26 (end of FY)', () => {
    const fy = financialYear(new Date('2026-03-31T12:00:00Z'));
    expect(fy.fyLabel).toBe('2025-26');
  });

  // ── IST boundary regression (the UTC-vs-IST bug) ──────────────────────────
  // 31 Mar 18:30–23:59 UTC = 1 Apr 00:00–05:29 IST → MUST be the NEW FY.

  it('31 Mar 2026 18:30:00 UTC (= 1 Apr 00:00 IST) flips to FY 2026-27', () => {
    const fy = financialYear(new Date('2026-03-31T18:30:00Z'));
    expect(fy.fyLabel).toBe('2026-27');
    expect(fy.start).toEqual(FY_2026_START_UTC);
  });

  it('31 Mar 2026 19:00:00 UTC (= 1 Apr 00:30 IST) is in the NEW FY 2026-27', () => {
    const ts = new Date('2026-03-31T19:00:00Z');
    const fy = financialYear(ts);
    expect(fy.fyLabel).toBe('2026-27');
    // The timestamp falls within [start, endExclusive) of the new FY.
    expect(ts.getTime()).toBeGreaterThanOrEqual(fy.start.getTime());
    expect(ts.getTime()).toBeLessThan(fy.endExclusive.getTime());
  });

  it('31 Mar 2026 18:29:59 UTC (= 31 Mar 23:59:59 IST) is still the OLD FY 2025-26', () => {
    const fy = financialYear(new Date('2026-03-31T18:29:59Z'));
    expect(fy.fyLabel).toBe('2025-26');
  });
});

describe('fyFromLabel', () => {
  it('parses "2025-26" correctly (IST-anchored start)', () => {
    const fy = fyFromLabel('2025-26');
    expect(fy.fyLabel).toBe('2025-26');
    expect(fy.start).toEqual(new Date('2025-03-31T18:30:00Z')); // 1 Apr 2025 00:00 IST
  });

  it('parses "2023-24" correctly (IST-anchored start)', () => {
    const fy = fyFromLabel('2023-24');
    expect(fy.fyLabel).toBe('2023-24');
    expect(fy.start).toEqual(new Date('2023-03-31T18:30:00Z')); // 1 Apr 2023 00:00 IST
  });

  it('throws on invalid format', () => {
    expect(() => fyFromLabel('2025')).toThrow(/Invalid FY label/);
    expect(() => fyFromLabel('25-26')).toThrow(/Invalid FY label/);
  });

  it('throws on inconsistent short year', () => {
    expect(() => fyFromLabel('2025-27')).toThrow(/Inconsistent FY label/);
  });
});

describe('fyOfToday', () => {
  it('returns a valid FyInfo with a consistent label and a full-year span', () => {
    const fy = fyOfToday();
    expect(fy.fyLabel).toMatch(/^\d{4}-\d{2}$/);
    const spanMs = fy.endExclusive.getTime() - fy.start.getTime();
    // Span is either 365 or 366 days (leap year)
    const day = 24 * 3600 * 1000;
    expect(spanMs === 365 * day || spanMs === 366 * day).toBe(true);
    // start is always 1 April 00:00 IST → in IST wall-clock that is April 1.
    const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
    const startIst = new Date(fy.start.getTime() + IST_OFFSET_MS);
    expect(startIst.getUTCMonth()).toBe(3); // April (0-indexed) in IST
    expect(startIst.getUTCDate()).toBe(1);
  });
});
