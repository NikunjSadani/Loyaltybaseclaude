import { escapeHtml, ticketEmailLink, ticketPath } from './ticket-link';

describe('ticketEmailLink', () => {
  const base = { clientId: 'bajaj', ticketId: 't 1' };

  it('prod origin → tenant primary domain', () => {
    expect(ticketEmailLink({ ...base, callerOrigin: 'https://app.gifsy.in', tenantPrimaryDomain: 'bajajloyalty.gifsy.in' }))
      .toBe('https://bajajloyalty.gifsy.in/admin/tickets?ticket=t%201');
  });

  it('staging origin (uat- or uat.) → uat- tenant host; slug fallback; no double prefix', () => {
    expect(ticketEmailLink({ ...base, callerOrigin: 'https://uat-app.gifsy.in' }))
      .toBe('https://uat-bajaj.gifsy.in/admin/tickets?ticket=t%201');
    expect(ticketEmailLink({ ...base, callerOrigin: 'https://uat.app.gifsy.in', tenantPrimaryDomain: 'uat-x.gifsy.in' }))
      .toBe('https://uat-x.gifsy.in/admin/tickets?ticket=t%201');
  });

  it('local dev origin is used as-is', () => {
    expect(ticketEmailLink({ ...base, callerOrigin: 'http://localhost:3000' }))
      .toBe('http://localhost:3000/admin/tickets?ticket=t%201');
  });

  it('staging + a custom (non-platform) primary domain → the slug host staging form', () => {
    expect(ticketEmailLink({ ...base, callerOrigin: 'https://uat-app.gifsy.in', tenantPrimaryDomain: 'rewards.client.com' }))
      .toBe('https://uat-bajaj.gifsy.in/admin/tickets?ticket=t%201');
  });

  it('a deployed API whose origin fell back to localhost still links the real tenant host', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(ticketEmailLink({ ...base, callerOrigin: 'https://localhost' })).toBe('https://bajaj.gifsy.in/admin/tickets?ticket=t%201');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('an unparseable origin falls back to the prod tenant host', () => {
    expect(ticketEmailLink({ ...base, callerOrigin: 'not a url' })).toBe('https://bajaj.gifsy.in/admin/tickets?ticket=t%201');
  });

  it('path + escaping helpers', () => {
    expect(ticketPath('abc')).toBe('/admin/tickets?ticket=abc');
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });
});
