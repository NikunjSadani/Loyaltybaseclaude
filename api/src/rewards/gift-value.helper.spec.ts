import { computeFrozenValuePaise } from './gift-value.helper';

describe('computeFrozenValuePaise (canonical value freeze §14)', () => {
  it('GIFT: uses sellingValuePaise × quantity (ignores rate)', () => {
    const v = computeFrozenValuePaise({
      isCashMode: false,
      sellingValuePaiseSnapshot: 50000, // ₹500
      quantity: 3,
      points: 999999, // deliberately inconsistent — must be ignored for gifts
      rateCenti: 100,
    });
    expect(v).toBe(150000n); // ₹1500
  });

  it('GIFT is RATE-IMMUNE — a rate change never re-values a placed gift', () => {
    const atRateA = computeFrozenValuePaise({
      isCashMode: false,
      sellingValuePaiseSnapshot: 50000,
      quantity: 1,
      points: 500,
      rateCenti: 100, // rate 1.0
    });
    const atRateB = computeFrozenValuePaise({
      isCashMode: false,
      sellingValuePaiseSnapshot: 50000,
      quantity: 1,
      points: 500,
      rateCenti: 250, // rate 2.5 — different
    });
    expect(atRateA).toBe(50000n);
    expect(atRateB).toBe(50000n); // unchanged
  });

  it('CASH: keeps points ÷ rate (the payout amount), never the selling snapshot', () => {
    // 1000 points at rate 1.0 (rateCenti 100) → ₹1000 → 100000 paise.
    const v = computeFrozenValuePaise({
      isCashMode: true,
      sellingValuePaiseSnapshot: 50000, // present but must be ignored for cash
      quantity: 1,
      points: 1000,
      rateCenti: 100,
    });
    expect(v).toBe(100000n);
  });

  it('NON-gift (no snapshot) falls back to points ÷ rate', () => {
    const v = computeFrozenValuePaise({
      isCashMode: false,
      sellingValuePaiseSnapshot: null,
      quantity: 1,
      points: 1000,
      rateCenti: 100,
    });
    expect(v).toBe(100000n);
  });

  it('a ZERO snapshot falls back to points ÷ rate (FREE_AMOUNT under-report guard)', () => {
    // A 0 sellingValuePaiseSnapshot means no real value was frozen (e.g. a FREE_AMOUNT
    // voucher, or a backfill that skipped a valueless row). Using it as the value would
    // zero out 194R Source-2 + the disbursal report — so fall through to points ÷ rate.
    const v = computeFrozenValuePaise({
      isCashMode: false,
      sellingValuePaiseSnapshot: 0,
      quantity: 2, // must be IGNORED once we fall back (fallback is not qty-multiplied)
      points: 1000,
      rateCenti: 100, // rate 1.0 → ₹1000
    });
    expect(v).toBe(100000n);
  });

  it('rate 0 (misconfig) → 0 for the fallback path', () => {
    const v = computeFrozenValuePaise({
      isCashMode: true,
      sellingValuePaiseSnapshot: null,
      quantity: 1,
      points: 1000,
      rateCenti: 0,
    });
    expect(v).toBe(0n);
  });
});
