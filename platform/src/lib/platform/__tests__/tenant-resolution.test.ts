/**
 * TDD tests for tenant resolution from hostname.
 * Run: npx vitest run src/lib/platform/__tests__/tenant-resolution.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSlugFromHostname,
  resolveClientConfig,
  DEFAULT_DEV_SLUG,
} from '../tenant-resolution';

// ─────────────────────────────────────────────────────────────────────────────
// resolveSlugFromHostname
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveSlugFromHostname', () => {
  it('extracts subdomain from a 3-part hostname', () => {
    expect(resolveSlugFromHostname('deoleo.gifsy.in')).toBe('deoleo');
  });

  it('extracts subdomain from a 4-part hostname (www.x.y.z)', () => {
    expect(resolveSlugFromHostname('clientb.app.gifsy.in')).toBe('clientb');
  });

  it('returns the dev default for localhost', () => {
    expect(resolveSlugFromHostname('localhost')).toBe(DEFAULT_DEV_SLUG);
  });

  it('returns the dev default for localhost with port', () => {
    expect(resolveSlugFromHostname('localhost:3000')).toBe(DEFAULT_DEV_SLUG);
  });

  it('returns null for the bare platform domain (no subdomain)', () => {
    expect(resolveSlugFromHostname('gifsy.in')).toBeNull();
  });

  it('returns null for the www root', () => {
    expect(resolveSlugFromHostname('www.gifsy.in')).toBeNull();
  });

  // ── GIFSY operator console (app.gifsy.in → 'gifsy') ─────────────────────────
  it('maps the operator console app.gifsy.in to the gifsy slug', () => {
    expect(resolveSlugFromHostname('app.gifsy.in')).toBe('gifsy');
  });

  it('maps the staging operator console uat.app.gifsy.in to the gifsy slug', () => {
    expect(resolveSlugFromHostname('uat.app.gifsy.in')).toBe('gifsy');
  });

  // ── Staging `uat.` prefix on TENANT domains (the login-bounce bug) ───────────
  it('maps the staging branded tenant domain uat.deoleoloyalty.gifsy.in to deoleo', () => {
    expect(resolveSlugFromHostname('uat.deoleoloyalty.gifsy.in')).toBe('deoleo');
  });

  it('maps a staging subdomain tenant uat.deoleo.gifsy.in to deoleo', () => {
    expect(resolveSlugFromHostname('uat.deoleo.gifsy.in')).toBe('deoleo');
  });

  it('maps a staging subdomain tenant uat.clientb.app.gifsy.in to clientb', () => {
    expect(resolveSlugFromHostname('uat.clientb.app.gifsy.in')).toBe('clientb');
  });

  it('is case/port-insensitive for the staging tenant prefix', () => {
    expect(resolveSlugFromHostname('UAT.DeoleoLoyalty.Gifsy.In:443')).toBe('deoleo');
  });

  it('operator-console match is case-insensitive and ignores the port', () => {
    expect(resolveSlugFromHostname('APP.Gifsy.In:443')).toBe('gifsy');
    expect(resolveSlugFromHostname('UAT.App.Gifsy.In')).toBe('gifsy');
  });

  it('still treats other reserved platform subdomains as null', () => {
    expect(resolveSlugFromHostname('platform.gifsy.in')).toBeNull();
    expect(resolveSlugFromHostname('admin.gifsy.in')).toBeNull();
  });

  it('is case-insensitive — normalises to lowercase', () => {
    expect(resolveSlugFromHostname('DEOLEO.gifsy.in')).toBe('deoleo');
  });

  it('handles an empty string gracefully', () => {
    expect(resolveSlugFromHostname('')).toBe(DEFAULT_DEV_SLUG);
  });

  // ── Custom branded-domain map (deoleoloyalty.gifsy.in → deoleo) ──────────────
  it('maps a branded custom domain to its tenant slug (label ≠ slug)', () => {
    expect(resolveSlugFromHostname('deoleoloyalty.gifsy.in')).toBe('deoleo');
  });

  it('custom-domain map is case-insensitive', () => {
    expect(resolveSlugFromHostname('DeoleoLoyalty.Gifsy.In')).toBe('deoleo');
  });

  it('custom-domain map ignores the port', () => {
    expect(resolveSlugFromHostname('deoleoloyalty.gifsy.in:3000')).toBe('deoleo');
  });

  it('a branded domain still round-trips to the right config', () => {
    const slug = resolveSlugFromHostname('deoleoloyalty.gifsy.in');
    const cfg  = resolveClientConfig(slug!);
    expect(cfg!.slug).toBe('deoleo');
    expect(cfg!.branding.displayName).toBe('Deoleo India');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveClientConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveClientConfig', () => {
  it('returns deoleo config for slug "deoleo"', () => {
    const cfg = resolveClientConfig('deoleo');
    expect(cfg).not.toBeNull();
    expect(cfg!.slug).toBe('deoleo');
  });

  it('returns null for an unknown slug', () => {
    expect(resolveClientConfig('totally-unknown-client-xyz')).toBeNull();
  });

  it('returns null for an empty slug', () => {
    expect(resolveClientConfig('')).toBeNull();
  });

  it('is case-insensitive', () => {
    const cfg = resolveClientConfig('DEOLEO');
    expect(cfg).not.toBeNull();
    expect(cfg!.slug).toBe('deoleo');
  });

  it('full round-trip: hostname → slug → config', () => {
    const slug = resolveSlugFromHostname('deoleo.gifsy.in');
    const cfg  = resolveClientConfig(slug!);
    expect(cfg!.slug).toBe('deoleo');
    expect(cfg!.branding.primaryColor).toBe('#16a34a');
  });
});
