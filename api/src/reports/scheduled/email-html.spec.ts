import { emailShell, table, statRow, esc, rupees } from './email-html';

describe('rupees — one rounding rule for BigInt and number paise (half up, whole rupees)', () => {
  it('rounds BigInt and number inputs identically', () => {
    for (const p of [0, 49, 50, 99, 150, 12_345_67, 12_345_50, 12_345_49]) {
      expect(rupees(BigInt(p))).toBe(rupees(p));
    }
    expect(rupees(150n)).toBe('₹2'); // was ₹1 (BigInt truncated) while 150 gave ₹2
    expect(rupees(149n)).toBe('₹1');
    expect(rupees(12_345_50n)).toBe('₹12,346');
  });

  it('negative amounts round symmetrically (half away from zero) for both input types', () => {
    expect(rupees(-150n)).toBe('-₹2');
    expect(rupees(-150)).toBe('-₹2');
    expect(rupees(-149n)).toBe('-₹1');
  });
});

describe('emailShell footer note', () => {
  it('renders an escaped red footer note when given (e.g. dropped recipients)', () => {
    const html = emailShell({ title: 't', body: '', dateLabel: 'd', footerNote: 'Not sent to <x@acme.com>' });
    expect(html).toContain('Not sent to &lt;x@acme.com&gt;');
  });
});

/**
 * Locks the responsive-email hooks so a future refactor can't silently regress the mobile
 * layout (verified at 375px: thead hidden, cells stack, data-label prefixes, pills stack).
 */
describe('email-html responsive + safety hooks', () => {
  it('emailShell emits a full doc with viewport + the ≤480px media query + card hook', () => {
    const html = emailShell({ title: 'KYC actionables', body: '<p>x</p>', dateLabel: '12 Aug 2026' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('@media only screen and (max-width:480px)');
    expect(html).toContain('class="rpt-card"');
    // the mobile rules that collapse the table + stack the pills must be present
    expect(html).toContain('.rpt-table td{');
    expect(html).toContain('.rpt-stats td{');
    expect(html).toContain('data-label');
  });

  it('table carries the responsive class + a data-label per cell (for the mobile card view)', () => {
    const html = table(
      [{ label: 'Tenant' }, { label: 'Pending', align: 'right' }],
      [['Deoleo India', '15']],
    );
    expect(html).toContain('class="rpt-table"');
    expect(html).toContain('data-label="Tenant"');
    expect(html).toContain('data-label="Pending"');
  });

  it('statRow carries the responsive class so pills can stack on mobile', () => {
    const html = statRow([{ label: 'Total pending', value: '15' }]);
    expect(html).toContain('class="rpt-stats"');
  });

  it('still HTML-escapes dynamic values (no markup injection)', () => {
    expect(esc('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    // a malicious column label used as a data-label is escaped too
    const html = table([{ label: '"><b>x' }], [['v']]);
    expect(html).toContain('data-label="&quot;&gt;&lt;b&gt;x"');
    expect(html).not.toContain('data-label=""><b>x');
  });
});
