import { describe, expect, it } from 'vitest';
import { neutralFulfillerText, VIA_API } from '@/lib/fulfiller-name';
import { cellSafe, aoaToSheetSafe } from '@/lib/xlsx-safe';
import { pdfSafe } from '@/lib/wallet-statement/statement-pdf';
import { isApiFulfillerProvider, withConsoleFulfillerFields } from '@/lib/redemption-order-transitions';

/** OWNER RULE (2026-11-26): no client screen and no downloaded file names the voucher fulfiller. */
describe('fulfiller name (FE mirror of api/src/common/fulfiller-name.ts)', () => {
  it('same core mappings as the API', () => {
    expect(neutralFulfillerText('Hubble')).toBe(VIA_API);
    expect(neutralFulfillerText('Vouchers (Hubble)')).toBe('Vouchers (Via API)');
    expect(neutralFulfillerText('Retry with Hubble')).toBe('Retry via API');
    expect(neutralFulfillerText('HUBBLE_INDETERMINATE')).toBe('API_INDETERMINATE');
    expect(neutralFulfillerText('Refund BAJ-1 (Hubble failed)')).not.toMatch(/hubble/i);
  });

  it('every FE download path drops the name: xlsx cells and PDF text', () => {
    expect(cellSafe('Refund BAJAJ-26-1 (Hubble failed)')).not.toMatch(/hubble/i);
    expect(cellSafe('=Hubble')).toBe("'=Via API");
    const ws = aoaToSheetSafe([['Description'], ['Hubble voucher issued']]);
    expect(JSON.stringify(ws)).not.toMatch(/hubble/i);
    expect(pdfSafe('Refund (Hubble failed) ₹500')).not.toMatch(/hubble/i);
  });

  it('console helpers accept the neutral spellings a client admin receives', () => {
    expect(isApiFulfillerProvider('Via API')).toBe(true);
    expect(isApiFulfillerProvider('Hubble')).toBe(true);
    expect(isApiFulfillerProvider('Amazon')).toBe(false);
    const o = withConsoleFulfillerFields({ id: 'o1', apiNeedsReconcile: true, apiReconcileReason: 'API_INDETERMINATE', apiHanded: true });
    expect(o).toEqual({ id: 'o1', hubbleNeedsReconcile: true, hubbleReconcileReason: 'HUBBLE_INDETERMINATE', hubbleHanded: true });
    const raw = { id: 'o2', hubbleNeedsReconcile: false };
    expect(withConsoleFulfillerFields(raw)).toBe(raw);
  });
});
