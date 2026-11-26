import { neutralFulfillerDeep, neutralFulfillerHtml, neutralFulfillerKey, neutralFulfillerText, VIA_API } from './fulfiller-name';

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

  it('keys: hubbleNeedsReconcile → apiNeedsReconcile', () => {
    expect(neutralFulfillerKey('hubbleNeedsReconcile')).toBe('apiNeedsReconcile');
    expect(neutralFulfillerKey('lastHubbleCheck')).toBe('lastApiCheck');
  });

  it('deep: values always, keys only on request; non-plain values untouched', () => {
    const d = new Date();
    const input = { a: 'Hubble', n: 1, d, big: BigInt(3), list: [{ voucherProvider: 'Hubble', hubbleHanded: true }] };
    const vOnly = neutralFulfillerDeep(input);
    expect(vOnly.a).toBe(VIA_API);
    expect(vOnly.d).toBe(d);
    expect(vOnly.big).toBe(BigInt(3));
    expect(Object.keys(vOnly.list[0])).toContain('hubbleHanded');
    const all = neutralFulfillerDeep(input, { keys: true });
    expect(JSON.stringify(all, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(NO_NAME);
    // Unchanged subtrees keep their reference.
    const clean = { x: [{ y: 'ok' }] };
    expect(neutralFulfillerDeep(clean)).toBe(clean);
  });

  it('html: text + titles neutralised, links untouched', () => {
    const html = '<p title="Hubble">Vouchers (Hubble)</p><a href="https://x.test/hubble-x">open</a>';
    const out = neutralFulfillerHtml(html);
    expect(out).toContain('href="https://x.test/hubble-x"');
    expect(out).toContain('Vouchers (Via API)');
    expect(out).toContain('title="Via API"');
  });
});
