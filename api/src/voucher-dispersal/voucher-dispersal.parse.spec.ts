import * as XLSX from 'xlsx';
import type { HubbleProduct } from '../hubble/hubble.service';
import {
  DISPERSAL_MAX_ROWS,
  DispersalBrandLimits,
  DispersalFileError,
  normalisePhone,
  parseRupees,
  readDispersalSheet,
  validateDispersalRows,
} from './voucher-dispersal.parse';
import { buildDispersalTemplate } from './voucher-dispersal.xlsx';
import { parseBrandOverride, configuredDispersalBrands } from './voucher-dispersal.brands';

const flex: HubbleProduct = { productId: 'AMZ', name: 'Amazon Pay', denominationType: 'FLEXIBLE', denominations: [], minValue: 500, maxValue: 10000, maxVouchersPerOrder: 1 };
const fixed: HubbleProduct = { productId: 'FK', name: 'Flipkart', denominationType: 'FIXED', denominations: [150, 300, 1250], minValue: 150, maxValue: 10000, maxVouchersPerOrder: 1 };
const BRANDS: DispersalBrandLimits[] = [
  { key: 'AMAZON_PAY', label: 'Amazon Pay', productId: 'AMZ', available: true, unavailableReason: null, product: flex },
  { key: 'FLIPKART', label: 'Flipkart', productId: 'FK', available: true, unavailableReason: null, product: fixed },
  { key: 'MYNTRA', label: 'Myntra', productId: 'MY', available: false, unavailableReason: 'Hubble timeout', product: null },
];
const row = (n: number, cells: Record<string, unknown>) => ({ rowNumber: n, cells: { phone: null, name: null, amount: null, brand: null, note: null, ...cells } });

function xlsx(aoa: unknown[][], sheet = 'Recipients'): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('normalisePhone', () => {
  it.each([
    ['9876543210', '9876543210'],
    [9876543210, '9876543210'],
    ['+91 98765 43210', '9876543210'],
    ['919876543210', '9876543210'],
    ['09876543210', '9876543210'],
    ['98765-43210', '9876543210'],
  ])('%p → %p', (raw, out) => expect(normalisePhone(raw)).toBe(out));
  it.each(['12345', '5876543210', 'abc9876543210', '', null, '98765432101'])('rejects %p', (raw) => expect(normalisePhone(raw)).toBeNull());
});

describe('parseRupees', () => {
  it('reads numbers and ₹ / comma text', () => {
    expect(parseRupees(1000)).toBe(1000);
    expect(parseRupees('₹1,000')).toBe(1000);
    expect(parseRupees('Rs. 500')).toBe(500);
    expect(parseRupees('12.5')).toBe(12.5);
    expect(parseRupees('ten')).toBeNull();
  });
});

describe('validateDispersalRows', () => {
  it('a good row is VALID and owns its phone', () => {
    const [r] = validateDispersalRows([row(2, { phone: '9876543210', name: 'Asha', amount: 1000, brand: 'Amazon Pay' })], BRANDS);
    expect(r).toMatchObject({ status: 'VALID', phone: '9876543210', dedupePhone: '9876543210', amountRupees: 1000, brandKey: 'AMAZON_PAY', productId: 'AMZ', invalidReason: null });
  });

  it('brand matches key or label case-insensitively', () => {
    const [a, b] = validateDispersalRows(
      [row(2, { phone: '9876543210', name: 'A', amount: 300, brand: 'flipkart' }), row(3, { phone: '9876543211', name: 'B', amount: 600, brand: 'amazon_pay' })],
      BRANDS,
    );
    expect(a.status).toBe('VALID');
    expect(b.status).toBe('VALID');
  });

  it('every problem is visible as a reason (no silent pass-through)', () => {
    const out = validateDispersalRows(
      [
        row(2, { phone: '123', name: 'A', amount: 1000, brand: 'Amazon Pay' }),
        row(3, { phone: '9876543211', name: '', amount: 1000, brand: 'Amazon Pay' }),
        row(4, { phone: '9876543212', name: 'C', amount: 400, brand: 'Amazon Pay' }),
        row(5, { phone: '9876543213', name: 'D', amount: 20000, brand: 'Amazon Pay' }),
        row(6, { phone: '9876543214', name: 'E', amount: 500, brand: 'Flipkart' }),
        row(7, { phone: '9876543215', name: 'F', amount: 1000.5, brand: 'Amazon Pay' }),
        row(8, { phone: '9876543216', name: 'G', amount: 1000, brand: 'Nykaa' }),
        row(9, { phone: '9876543217', name: 'H', amount: 1000, brand: 'Myntra' }),
        row(10, { phone: '9876543218', name: 'I', amount: -5, brand: 'Amazon Pay' }),
        row(11, { phone: '9876543219', name: 'J', amount: null, brand: 'Amazon Pay' }),
        row(12, { phone: '9876543220', name: 'K'.repeat(61), amount: 1000, brand: 'Amazon Pay' }),
      ],
      BRANDS,
    );
    expect(out.every((r) => r.status === 'INVALID' && !!r.invalidReason)).toBe(true);
    expect(out[0].invalidReason).toMatch(/10-digit/);
    expect(out[1].invalidReason).toMatch(/Name is missing/);
    expect(out[2].invalidReason).toMatch(/not issuable for Amazon Pay/);
    expect(out[3].invalidReason).toMatch(/not issuable/);
    expect(out[4].invalidReason).toMatch(/fixed amounts only: ₹150, ₹300, ₹1,250/);
    expect(out[5].invalidReason).toMatch(/whole rupees/);
    expect(out[6].invalidReason).toMatch(/Unknown brand "Nykaa"/);
    expect(out[7].invalidReason).toMatch(/could not be loaded from Hubble \(Hubble timeout\)/);
    expect(out[8].invalidReason).toMatch(/positive/);
    expect(out[9].invalidReason).toMatch(/Amount is missing/);
    expect(out[10].invalidReason).toMatch(/longer than 60/);
  });

  it('the SECOND row with a phone is DUPLICATE (the first owns it, even if the first is invalid)', () => {
    const out = validateDispersalRows(
      [
        row(2, { phone: '9876543210', name: 'A', amount: 100, brand: 'Amazon Pay' }),
        row(3, { phone: '+91 98765 43210', name: 'B', amount: 1000, brand: 'Amazon Pay' }),
        row(4, { phone: '09876543210', name: 'C', amount: 1000, brand: 'Amazon Pay' }),
      ],
      BRANDS,
    );
    expect(out[0]).toMatchObject({ status: 'INVALID', dedupePhone: '9876543210' });
    expect(out[1]).toMatchObject({ status: 'DUPLICATE', dedupePhone: null, invalidReason: expect.stringMatching(/Same phone as row 2/) });
    expect(out[2]).toMatchObject({ status: 'DUPLICATE', dedupePhone: null });
  });

  it('a FIXED brand whose list Hubble did not return falls back to min/max', () => {
    const unknownList: DispersalBrandLimits = { ...BRANDS[1], product: { ...fixed, denominations: [] } };
    const [r] = validateDispersalRows([row(2, { phone: '9876543210', name: 'A', amount: 777, brand: 'Flipkart' })], [unknownList]);
    expect(r.status).toBe('VALID');
  });
});

describe('readDispersalSheet', () => {
  it('maps the template headers, keeps Excel row numbers and skips blank rows', () => {
    const buf = xlsx([
      ['Phone', 'Name', 'Amount (₹)', 'Brand', 'Note'],
      ['9876543210', 'Asha', 1000, 'Amazon Pay', 'n1'],
      [null, null, null, null, null],
      [9876543211, 'Ravi', '₹500', 'Flipkart', null],
    ]);
    const out = readDispersalSheet(buf);
    expect(out.map((r) => r.rowNumber)).toEqual([2, 4]);
    expect(out[1].cells).toMatchObject({ phone: 9876543211, name: 'Ravi', amount: '₹500', brand: 'Flipkart' });
  });

  it('refuses a file missing a required column', () => {
    expect(() => readDispersalSheet(xlsx([['Phone', 'Name', 'Brand'], ['9876543210', 'A', 'Amazon Pay']]))).toThrow(/Missing column\(s\): Amount/);
  });

  it('refuses garbage, an empty sheet and too many rows', () => {
    expect(() => readDispersalSheet(Buffer.from('not a workbook at all'))).toThrow(DispersalFileError);
    expect(() => readDispersalSheet(xlsx([['Phone', 'Name', 'Amount', 'Brand']]))).toThrow(/No recipient rows/);
    const many = [['Phone', 'Name', 'Amount', 'Brand'], ...Array.from({ length: DISPERSAL_MAX_ROWS + 1 }, (_, i) => [`98${String(i).padStart(8, '0')}`, 'X', 500, 'Amazon Pay'])];
    expect(() => readDispersalSheet(xlsx(many))).toThrow(/Too many rows/);
  });
});

describe('template', () => {
  it('has the Recipients columns, a brand dropdown source and instructions; it reads back as an empty upload', async () => {
    const buf = await buildDispersalTemplate(BRANDS);
    const wb = XLSX.read(buf, { type: 'buffer' });
    expect(wb.SheetNames).toEqual(expect.arrayContaining(['Recipients', 'Brands', 'Instructions']));
    const header = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Recipients, { header: 1 })[0];
    expect(header).toEqual(['Phone', 'Name', 'Amount (₹)', 'Brand', 'Note']);
    const brands = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.Brands, { header: 1 }).map((r) => r[0]);
    expect(brands).toEqual(['Amazon Pay', 'Flipkart', 'Myntra']);
    expect(() => readDispersalSheet(buf)).toThrow(/No recipient rows/);
  });
});

describe('brand registry', () => {
  it('defaults to Amazon Pay + Flipkart; a valid env override wins; a malformed one is ignored', () => {
    expect(configuredDispersalBrands({} as NodeJS.ProcessEnv).map((b) => b.key)).toEqual(['AMAZON_PAY', 'FLIPKART']);
    expect(parseBrandOverride('[{"key":"myntra","label":"Myntra","productId":"01ABC"}]')).toEqual([{ key: 'MYNTRA', label: 'Myntra', productId: '01ABC' }]);
    expect(parseBrandOverride('[{"key":"x","label":"","productId":"1"}]')).toBeNull();
    expect(parseBrandOverride('not json')).toBeNull();
    expect(configuredDispersalBrands({ VOUCHER_DISPERSAL_BRANDS: 'oops' } as never).length).toBe(2);
  });
});
