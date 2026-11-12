import type { SalesColumnMapping } from '../sales-import.contract';
import { mappingFingerprint } from './mapping-fingerprint';

const M: SalesColumnMapping = {
  headerRow: 'auto', outletCode: 'CODE', outletName: 'NAME', invoiceDate: 'DATE', amount: 'AMT', quantity: 'QTY',
  dimensions: [{ key: 'dimA', label: 'Brand', header: 'BRAND' }], dateOrder: 'DMY',
};

describe('mappingFingerprint', () => {
  it('ignores display-only fields: dimension labels and the outlet-NAME column (re-audit M3); header case/spaces', () => {
    const fp = mappingFingerprint(M);
    expect(mappingFingerprint({ ...M, outletName: 'CUSTOMER NAME' })).toBe(fp);
    expect(mappingFingerprint({ ...M, outletName: null })).toBe(fp);
    expect(mappingFingerprint({ ...M, dimensions: [{ key: 'dimA', label: 'Other', header: ' brand ' }] })).toBe(fp);
  });

  it('changes with anything that changes the parsed numbers', () => {
    const fp = mappingFingerprint(M);
    for (const m of [
      { ...M, amount: 'NET' }, { ...M, quantity: null }, { ...M, outletCode: 'CUST' }, { ...M, invoiceDate: 'BILL DATE' },
      { ...M, dateOrder: 'MDY' as const }, { ...M, decimalSeparator: ',' as const }, { ...M, headerRow: 2 },
      { ...M, sheetName: 'Data' }, { ...M, dimensions: [{ key: 'dimB', label: 'Brand', header: 'BRAND' }] },
    ]) expect(mappingFingerprint(m)).not.toBe(fp);
    expect(mappingFingerprint(null)).toBeNull();
  });
});
