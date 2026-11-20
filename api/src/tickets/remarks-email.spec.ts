// "Remarks needed" email renderer (owner 2026-11-20). Run: npx jest src/tickets/remarks-email.spec.ts
import { RemarksEmailData, maskContactDetails, remarksEmailSubject, renderRemarksEmail } from './remarks-email';

const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

const base = (over: Partial<RemarksEmailData> = {}): RemarksEmailData => ({
  askerName: 'Priya (Gifsy)',
  note: 'Please confirm whether the October invoice for this outlet was approved.',
  askedAt: daysAgo(0),
  askedAdminName: 'Anil Shah',
  toInbox: true,
  link: 'https://uat-bajajloyalty.gifsy.in/admin/tickets?ticket=t1',
  now,
  ticket: { number: 'TKT-ABC1', category: 'POINTS', priority: 'HIGH', createdAt: daysAgo(4) },
  issue: { subject: 'Points not credited', description: 'Points for October are missing.' },
  outlet: { code: 'BAJ-0042', name: 'Gupta Stores', type: 'Retail', program: 'Bajaj Retail', subProgram: 'Gold', city: 'Pune', state: 'Maharashtra', kycStatus: 'Approved' },
  raisedBy: { label: 'Meera Iyer · ISR', manager: 'Rahul Verma · SO' },
  context: { heading: 'Points', lines: ['Current wallet balance: 12,500 redeemable points (lifetime earned 40,000).'] },
  messages: [{ who: 'Outlet owner — Ramesh Gupta', at: daysAgo(3), text: 'Still not credited.' }],
  ...over,
});

describe('remarksEmailSubject', () => {
  it('"Remarks needed: <TKT> · <Category> · Outlet <code>" / "· no outlet linked"', () => {
    expect(remarksEmailSubject(base())).toBe('Remarks needed: TKT-ABC1 · Points · Outlet BAJ-0042');
    expect(remarksEmailSubject(base({ outlet: null }))).toBe('Remarks needed: TKT-ABC1 · Points · no outlet linked');
  });
});

describe('renderRemarksEmail', () => {
  it('has every block, in order, ask first', () => {
    const { html } = renderRemarksEmail(base());
    const order = ['data-block="ask"', 'data-block="action"', 'data-block="ticket"', 'data-block="issue"', 'data-block="outlet"',
      'data-block="raised-by"', 'data-block="context"', 'data-block="conversation"'];
    const pos = order.map((b) => html.indexOf(b));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it('ask block: who asked, the note verbatim, asked-on time, "Asked: <admin>" when sent to the inbox', () => {
    const { html } = renderRemarksEmail(base());
    expect(html).toContain('Priya (Gifsy) (Gifsy support) needs your remarks:');
    expect(html).toContain('Please confirm whether the October invoice for this outlet was approved.');
    expect(html).toMatch(/Asked on \d{1,2} \w{3} \d{4}, \d{1,2}:\d{2} (am|pm) IST · Asked: Anil Shah/);
    expect(renderRemarksEmail(base({ toInbox: false })).html).not.toContain('Asked: Anil Shah');
  });

  it('button + the honest "replies to this email are not read" line', () => {
    const { html } = renderRemarksEmail(base());
    expect(html).toContain('href="https://uat-bajajloyalty.gifsy.in/admin/tickets?ticket=t1"');
    expect(html).toContain('Open ticket &amp; reply');
    expect(html).toContain('Please reply in the portal — replies to this email are not read.');
  });

  it('ticket block: number, category, priority, status, raised on + age', () => {
    const { html } = renderRemarksEmail(base());
    for (const t of ['TKT-ABC1', '>Points<', '>High<', 'Awaiting your remarks', '(4 days ago)']) expect(html).toContain(t);
  });

  it('issue: subject + original description, truncated at ~800 chars with a pointer to the portal', () => {
    const long = 'x'.repeat(900);
    const { html } = renderRemarksEmail(base({ issue: { subject: 'S', description: long } }));
    expect(html).toContain(`${'x'.repeat(800)}… (full text in the portal)`);
    expect(html).not.toContain('x'.repeat(801));
  });

  it('outlet block, and "Outlet: not linked" when none', () => {
    expect(renderRemarksEmail(base()).html).toContain('BAJ-0042 · Gupta Stores');
    expect(renderRemarksEmail(base()).html).toContain('Bajaj Retail / Gold');
    expect(renderRemarksEmail(base({ outlet: null })).html).toContain('Outlet: not linked');
  });

  it('raised by + reports to (salesperson); conversation lines truncated at ~300', () => {
    const { html } = renderRemarksEmail(base({ messages: [{ who: 'A', at: now, text: 'y'.repeat(400) }] }));
    expect(html).toContain('Meera Iyer · ISR');
    expect(html).toContain('Rahul Verma · SO');
    expect(html).toContain(`${'y'.repeat(300)}… (more in the portal)`);
  });

  it('escapes every value and masks phones / emails in free text', () => {
    const { html, subject } = renderRemarksEmail(base({
      note: '<script>x</script> call 98765 43210 or +91-9876543210, mail a.b@c.com',
      issue: { subject: '<b>S</b>', description: 'Outlet: Gupta (9123456789)' },
      outlet: { code: 'B&J', name: '<img src=x>' },
      raisedBy: { label: '<i>Evil</i>' },
      messages: [{ who: 'Q"', at: now, text: 'ring 08012345678' }],
    }));
    expect(html).not.toMatch(/<script>|<img src=x>|<b>S<\/b>|<i>Evil<\/i>/);
    expect(html).toContain('B&amp;J · &lt;img src=x&gt;');
    expect(html).not.toMatch(/(?<!\d)(?:\+?91[\s-]?|0)?[6-9](?:[\s-]?\d){9}(?!\d)/);
    expect(html).not.toContain('a.b@c.com');
    expect(subject).toBe('Remarks needed: TKT-ABC1 · Points · Outlet B&J'); // subject is plain text, not HTML
  });

  it('mobile-friendly: table layout with inline styles, no CSS grid / <style> blocks', () => {
    const { html } = renderRemarksEmail(base());
    expect(html.startsWith('<table role="presentation" width="100%"')).toBe(true);
    expect(html).toContain('max-width:600px');
    expect(html).not.toMatch(/display:\s*grid|<style/);
  });
});

describe('maskContactDetails', () => {
  it.each([
    ['9876543210', '[phone hidden]'],
    ['+91 98765 43210', '[phone hidden]'],
    ['098765-43210', '[phone hidden]'],
    ['someone@example.com', '[email hidden]'],
  ])('%s → %s', (raw, out) => {
    expect(maskContactDetails(raw)).toBe(out);
  });
  it('keeps ordinary numbers (amounts, dates, codes)', () => {
    expect(maskContactDetails('Invoice INV-0183 for ₹42,000 on 10/05/2026')).toBe('Invoice INV-0183 for ₹42,000 on 10/05/2026');
  });
});
