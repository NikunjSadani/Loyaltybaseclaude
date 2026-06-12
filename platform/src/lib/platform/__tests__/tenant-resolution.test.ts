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
    expect(resolveSlugFromHostname('deoleo.loyaltybase.in')).toBe('deoleo');
  });

  it('extracts subdomain from a 4-part hostname (www.x.y.z)', () => {
    expect(resolveSlugFromHostname('clientb.app.loyaltybase.in')).toBe('clientb');
  });

  it('returns the dev default for localhost', () => {
    expect(resolveSlugFromHostname('localhost')).toBe(DEFAULT_DEV_SLUG);
  });

  it('returns the dev default for localhost with port', () => {
    expect(resolveSlugFromHostname('localhost:3000')).toBe(DEFAULT_DEV_SLUG);
  });

  it('returns null for the bare platform domain (no subdomain)', () => {
    expect(resolveSlugFromHostname('loyaltybase.in')).toBeNull();
  });

  it('returns null for the www root', () => {
    expect(resolveSlugFromHostname('www.loyaltybase.in')).toBeNull();
  });

  it('returns null for app root (admin platform domain)', () => {
    expect(resolveSlugFromHostname('app.loyaltybase.in')).toBeNull();
  });

  it('is case-insensitive — normalises to lowercase', () => {
    expect(resolveSlugFromHostname('DEOLEO.loyaltybase.in')).toBe('deoleo');
  });

  it('handles an empty string gracefully', () => {
    expect(resolveSlugFromHostname('')).toBe(DEFAULT_DEV_SLUG);
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
    const slug = resolveSlugFromHostname('deoleo.loyaltybase.in');
    const cfg  = resolveClientConfig(slug!);
    expect(cfg!.slug).toBe('deoleo');
    expect(cfg!.branding.primaryColor).toBe('#16a34a');
  });
});
