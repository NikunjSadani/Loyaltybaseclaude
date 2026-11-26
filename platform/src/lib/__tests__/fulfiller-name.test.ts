import { describe, expect, it } from 'vitest';
import { neutralFulfillerText, VIA_API } from '@/lib/fulfiller-name';
import { cellSafe } from '@/lib/xlsx-safe';
import { pdfSafe } from '@/lib/wallet-statement/statement-pdf';
import { isApiFulfillerProvider } from '@/lib/redemption-order-transitions';

/** OWNER RULE (2026-11-26): no client screen names the voucher fulfiller — mapped field-level, for DISPLAY only. */
describe('fulfiller name (FE mirror of api/src/common/fulfiller-name.ts)', () => {
  it('same core mappings as the API', () => {
    expect(neutralFulfillerText('Hubble')).toBe(VIA_API);
    expect(neutralFulfillerText('Vouchers (Hubble)')).toBe('Vouchers (Via API)');
    expect(neutralFulfillerText('Retry with Hubble')).toBe('Retry via API');
    expect(neutralFulfillerText('HUBBLE_INDETERMINATE')).toBe('API_INDETERMINATE');
  });

  it('download helpers never rewrite real data (a name containing the word, a base64 data URL)', () => {
    const dataUrl = 'data:image/png;base64,aHViYmxlSHViYmxlSFVCQkxF/hubble+Hubble==';
    expect(cellSafe('Hubble Traders')).toBe('Hubble Traders');
    expect(cellSafe(dataUrl)).toBe(dataUrl);
    expect(pdfSafe('Hubble Traders')).toBe('Hubble Traders');
  });

  it('the console accepts the neutral provider spelling a client admin receives', () => {
    expect(isApiFulfillerProvider('Via API')).toBe(true);
    expect(isApiFulfillerProvider('Hubble')).toBe(true);
    expect(isApiFulfillerProvider('Amazon')).toBe(false);
  });
});
