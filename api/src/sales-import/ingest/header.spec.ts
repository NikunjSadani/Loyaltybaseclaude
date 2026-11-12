import type { SalesColumnMapping } from '../sales-import.contract';
import { resolveHeader, SourceRow } from './header';

const MAP: SalesColumnMapping = {
  sheetName: null,
  headerRow: 'auto',
  outletCode: 'Customer Code',
  outletName: 'Customer',
  invoiceDate: 'Invoice Date',
  amount: 'Net Amt',
  quantity: 'Qty',
  dimensions: [
    { key: 'dimA', label: 'Dim A', header: 'Code' },
    { key: 'dimB', label: 'Dim B', header: 'Group' },
  ],
  dateOrder: 'DMY',
};

const HEADER = ['Invoice Date', 'Customer Code', 'Customer', 'Code', 'Group', 'Net Amt', 'Qty', 'Other'];
const rows = (...r: unknown[][]): SourceRow[] => r.map((cells, i) => ({ rowNo: i + 1, cells }));

describe('resolveHeader', () => {
  it('auto-detect skips a marker row of X above the header', () => {
    const r = resolveHeader(rows(['X', 'X', 'X', 'X'], HEADER, ['01-10-2026', 1, 'n', 'a', 'b', 1, 1]), MAP);
    expect(r.needsMapping).toBe(false);
    if (r.needsMapping) return;
    expect(r.headerRowIdx).toBe(1);
    expect(r.headerRowNo).toBe(2);
    expect(r.colIdx).toEqual({ outletCode: 1, outletName: 2, invoiceDate: 0, amount: 5, quantity: 6, dims: { dimA: 3, dimB: 4 } });
  });

  it('"CODE" and "CUSTOMER CODE" both present → resolved to distinct columns (exact, not contains)', () => {
    const r = resolveHeader(rows(HEADER), MAP);
    if (r.needsMapping) throw new Error(r.reason);
    expect(r.colIdx.outletCode).toBe(1);
    expect(r.colIdx.dims.dimA).toBe(3);
  });

  it('is order-independent (shuffled columns) and whitespace/case-insensitive', () => {
    const shuffled = [' qty ', 'GROUP', 'other', 'net  amt', 'code', 'customer', 'CUSTOMER CODE', 'invoice date'];
    const r = resolveHeader(rows(shuffled), MAP);
    if (r.needsMapping) throw new Error(r.reason);
    expect(r.colIdx).toEqual({ outletCode: 6, outletName: 5, invoiceDate: 7, amount: 3, quantity: 0, dims: { dimA: 4, dimB: 1 } });
  });

  it('a fixed headerRow uses that sheet row number', () => {
    const r = resolveHeader(rows(['junk'], ['junk'], HEADER), { ...MAP, headerRow: 3 });
    if (r.needsMapping) throw new Error(r.reason);
    expect(r.headerRowIdx).toBe(2);
  });

  it('a fixed headerRow that is not the header → needsMapping with the missing list', () => {
    const r = resolveHeader(rows(['junk'], HEADER), { ...MAP, headerRow: 1 });
    expect(r.needsMapping).toBe(true);
  });

  it('a missing header → missing: ["INVOICE DATE"]', () => {
    const r = resolveHeader(rows(HEADER.filter((h) => h !== 'Invoice Date')), MAP);
    expect(r).toMatchObject({ needsMapping: true, missing: ['INVOICE DATE'], duplicates: [] });
  });

  it('a duplicate header → duplicates', () => {
    const r = resolveHeader(rows([...HEADER, 'net amt']), MAP);
    expect(r).toMatchObject({ needsMapping: true, missing: [], duplicates: ['NET AMT'] });
    if (r.needsMapping) expect(r.reason).toContain('more than once');
  });

  it('only scans the first 10 rows in auto mode', () => {
    const filler = Array.from({ length: 10 }, () => ['x']);
    expect(resolveHeader(rows(...filler, HEADER), MAP).needsMapping).toBe(true);
  });

  it('optional columns may be unmapped', () => {
    const r = resolveHeader(rows(HEADER), { ...MAP, outletName: null, quantity: null, dimensions: [] });
    if (r.needsMapping) throw new Error(r.reason);
    expect(r.colIdx).toMatchObject({ outletName: null, quantity: null, dims: {} });
  });

  it('a mapping without amount and quantity → needsMapping', () =>
    expect(resolveHeader(rows(HEADER), { ...MAP, amount: null, quantity: null }).needsMapping).toBe(true));

  it('two fields mapped to the same header → needsMapping', () =>
    expect(resolveHeader(rows(HEADER), { ...MAP, outletName: 'Customer Code' })).toMatchObject({
      needsMapping: true,
      duplicates: ['CUSTOMER CODE'],
    }));

  it('an empty file → needsMapping', () => expect(resolveHeader([], MAP).needsMapping).toBe(true));
});
