import { neutralFulfillerText, neutralRefundNarration, VIA_API } from './fulfiller-name';

/** OWNER RULE (2026-11-26): "Hubble" never reaches a client surface or a downloaded file. */
describe('fulfiller name neutralisation', () => {
  const NO_NAME = /hubble/i;

  it('maps the stored provider and platform notes to "Via API" words', () => {
    expect(neutralFulfillerText('Hubble')).toBe(VIA_API);
    expect(neutralFulfillerText('hubble')).toBe(VIA_API);
    expect(neutralFulfillerText(' HUBBLE ')).toBe(VIA_API);
    expect(neutralFulfillerText('Hubble voucher issued')).toBe('E-voucher issued via API');
    expect(neutralFulfillerText('Vouchers (Hubble)')).toBe('Vouchers (Via API)');
    expect(neutralFulfillerText('Retry with Hubble')).toBe('Retry via API');
    expect(neutralFulfillerText('Hubble: 2 vouchers failed')).toBe('Via API: 2 vouchers failed');
    expect(neutralFulfillerText("Check the order in Hubble's portal")).toBe("Check the order in the API provider's portal");
    expect(neutralFulfillerText('A Hubble-issued voucher cannot be cancelled')).toBe('An API-issued voucher cannot be cancelled');
    expect(neutralFulfillerText('HUBBLE_INDETERMINATE')).toBe('API_INDETERMINATE');
    expect(neutralFulfillerText('REFUNDED_NO_HUBBLE_ORDER')).toBe('REFUNDED_NO_API_ORDER');
  });

  it('never leaves the name behind, whatever the text', () => {
    const samples = [
      'Hubble failed — points refunded: Hubble said no',
      'hubbleNeedsReconcile', 'refundAndFailNoHubbleOrder', 'HuBbLe', 'xhubblex', "Hubble’s range",
      'Hubble Money productId', 'non-Hubble', 'Hubble reported activity on 2 orders — check with Hubble',
    ];
    for (const s of samples) expect(neutralFulfillerText(s)).not.toMatch(NO_NAME);
  });

  it('leaves text without the name untouched (same reference)', () => {
    const s = 'Amazon Pay voucher';
    expect(neutralFulfillerText(s)).toBe(s);
  });

  it('ledger: only the exact old refund narration is reworded; any other narration passes through', () => {
    expect(neutralRefundNarration('Refund BAJAJ-26-000050 (Hubble failed)')).toBe('Refund BAJAJ-26-000050 (voucher could not be issued)');
    expect(neutralRefundNarration('Bonus for Hubble Traders')).toBe('Bonus for Hubble Traders');
    expect(neutralRefundNarration(null)).toBeNull();
  });
});
