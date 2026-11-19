import { escapeHtml, linkEnvironment, ticketEmailLink, ticketPath } from './ticket-link';

// The environment comes from SERVER config, never from the caller's host.
const STAGING = { NODE_ENV: 'production', K_SERVICE: 'gifsy-api-staging', DATABASE_URL: 'postgresql://u:p@10.0.0.3:5432/gifsy_staging' };
const PROD = { NODE_ENV: 'production', K_SERVICE: 'gifsy-api', DATABASE_URL: 'postgresql://u:p@10.0.0.3:5432/gifsy_prod' };
const LOCAL = { NODE_ENV: 'development' };

describe('linkEnvironment', () => {
  it('explicit TENANT_LINK_ENV wins', () => {
    expect(linkEnvironment({ ...PROD, TENANT_LINK_ENV: 'staging' })).toBe('staging');
  });
  it('Cloud Run service name decides (staging vs prod)', () => {
    expect(linkEnvironment(STAGING)).toBe('staging');
    expect(linkEnvironment(PROD)).toBe('production');
  });
  it('falls back to the database name, then NODE_ENV', () => {
    expect(linkEnvironment({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/gifsy_staging?schema=public' })).toBe('staging');
    expect(linkEnvironment({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://x/gifsy_prod' })).toBe('production');
    expect(linkEnvironment(LOCAL)).toBe('local');
    expect(linkEnvironment({ NODE_ENV: 'production' })).toBe('production');
  });
});

describe('ticketEmailLink', () => {
  const base = { clientId: 'bajaj', ticketId: 't 1' };

  it('prod → tenant primary domain (else slug host), whatever the caller host', () => {
    expect(ticketEmailLink({ ...base, env: PROD, callerOrigin: 'https://app.gifsy.in', tenantPrimaryDomain: 'bajajloyalty.gifsy.in' }))
      .toBe('https://bajajloyalty.gifsy.in/admin/tickets?ticket=t%201');
    expect(ticketEmailLink({ ...base, env: PROD, callerOrigin: 'https://uat-app.gifsy.in' }))
      .toBe('https://bajaj.gifsy.in/admin/tickets?ticket=t%201');
  });

  it('staging config ALWAYS links uat- hosts — even from a localhost or *.run.app origin with NODE_ENV=production', () => {
    for (const callerOrigin of ['https://localhost', 'http://localhost:4000', 'https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app', 'https://app.gifsy.in', 'not a url']) {
      expect(ticketEmailLink({ ...base, env: STAGING, callerOrigin, tenantPrimaryDomain: 'bajajloyalty.gifsy.in' }))
        .toBe('https://uat-bajajloyalty.gifsy.in/admin/tickets?ticket=t%201');
    }
  });

  it('staging: slug fallback, no double prefix, custom domain → slug host staging form', () => {
    expect(ticketEmailLink({ ...base, env: STAGING, callerOrigin: 'x' })).toBe('https://uat-bajaj.gifsy.in/admin/tickets?ticket=t%201');
    expect(ticketEmailLink({ ...base, env: STAGING, callerOrigin: 'x', tenantPrimaryDomain: 'uat-x.gifsy.in' }))
      .toBe('https://uat-x.gifsy.in/admin/tickets?ticket=t%201');
    expect(ticketEmailLink({ ...base, env: STAGING, callerOrigin: 'x', tenantPrimaryDomain: 'rewards.client.com' }))
      .toBe('https://uat-bajaj.gifsy.in/admin/tickets?ticket=t%201');
  });

  it('prod config never links staging even when the caller is on a uat host or localhost', () => {
    expect(ticketEmailLink({ ...base, env: PROD, callerOrigin: 'https://localhost' })).toBe('https://bajaj.gifsy.in/admin/tickets?ticket=t%201');
  });

  it('local dev uses the caller origin (or localhost:3000)', () => {
    expect(ticketEmailLink({ ...base, env: LOCAL, callerOrigin: 'http://localhost:3000' })).toBe('http://localhost:3000/admin/tickets?ticket=t%201');
    expect(ticketEmailLink({ ...base, env: LOCAL, callerOrigin: 'not a url' })).toBe('http://localhost:3000/admin/tickets?ticket=t%201');
  });

  it('path + escaping helpers', () => {
    expect(ticketPath('abc')).toBe('/admin/tickets?ticket=abc');
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });
});
