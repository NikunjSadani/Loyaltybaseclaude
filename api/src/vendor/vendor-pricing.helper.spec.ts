import {
  assertVendorPriceBounds,
  VendorPriceError,
  VENDOR_MIN_SELLING_VALUE_PAISE,
} from './vendor-pricing.helper';

describe('assertVendorPriceBounds (review #8 — server-side price bounds)', () => {
  it('accepts a sane price within [floor, MRP]', () => {
    expect(() => assertVendorPriceBounds({ sellingValuePaise: 150000, mrpPaise: 199900 })).not.toThrow();
  });

  it('accepts sellingValue == MRP (100% cap boundary)', () => {
    expect(() => assertVendorPriceBounds({ sellingValuePaise: 199900, mrpPaise: 199900 })).not.toThrow();
  });

  it('REQUIRES mrpPaise (a mis-price inflates the outlet 194R base)', () => {
    expect(() => assertVendorPriceBounds({ sellingValuePaise: 150000, mrpPaise: null })).toThrow(
      VendorPriceError,
    );
    expect(() => assertVendorPriceBounds({ sellingValuePaise: 150000, mrpPaise: 0 })).toThrow(
      VendorPriceError,
    );
  });

  it('rejects a selling value ABOVE MRP (cap = 100% of MRP)', () => {
    expect(() => assertVendorPriceBounds({ sellingValuePaise: 200000, mrpPaise: 199900 })).toThrow(
      /exceed/i,
    );
  });

  it('rejects a selling value below the hard floor', () => {
    expect(() =>
      assertVendorPriceBounds({ sellingValuePaise: VENDOR_MIN_SELLING_VALUE_PAISE - 1, mrpPaise: 100000 }),
    ).toThrow(/at least/i);
  });

  it('rejects a missing/zero selling value', () => {
    expect(() => assertVendorPriceBounds({ sellingValuePaise: null, mrpPaise: 100000 })).toThrow(
      VendorPriceError,
    );
  });
});
