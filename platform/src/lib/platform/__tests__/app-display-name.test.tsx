/**
 * Per-client "App name" (branding.appName — owner 2026-11-20, Option A).
 *
 * The app name drives the installed-app label (manifest name/short_name + iOS title), the
 * browser tab title, the sign-in heading and app headers. When it is NOT set every surface
 * must be byte-identical to before (Deoleo unchanged). Company-name copy (consent, PDF)
 * keeps using branding.displayName.
 */
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../client-config';
import { DEOLEO_CONFIG } from '../client-registry';
import { DEFAULT_CLIENT_CONFIG } from '../default-client-config';
import { appDisplayName } from '../app-display-name';
import { buildManifest, pwaAppName } from '@/lib/pwa/manifest';
import { loyaltyProgrammeLabel } from '@/lib/programme-name';

let tenantConfig: ClientConfig = DEOLEO_CONFIG;
vi.mock('@/lib/platform/server', () => ({
  getTenantConfig: async () => tenantConfig,
  getBrandStyle: () => '',
}));
vi.mock('next/font/google', () => ({ Inter: () => ({ variable: '--font-inter' }) }));
vi.mock('@/components/layout/site-footer', () => ({ SiteFooter: () => null }));

const BAJAJ: ClientConfig = {
  ...DEFAULT_CLIENT_CONFIG,
  slug: 'bajaj',
  branding: {
    ...DEFAULT_CLIENT_CONFIG.branding,
    displayName: 'Bajaj Consumer Care Ltd',
    appName: 'Bajaj Loyalty Club',
  },
};

beforeEach(() => {
  tenantConfig = DEOLEO_CONFIG;
});

describe('appDisplayName', () => {
  it('uses appName when set (trimmed), else displayName', () => {
    expect(appDisplayName(BAJAJ.branding)).toBe('Bajaj Loyalty Club');
    expect(appDisplayName({ displayName: 'Co', appName: '  Co App ' })).toBe('Co App');
    expect(appDisplayName({ displayName: 'Co', appName: '   ' })).toBe('Co');
    expect(appDisplayName({ displayName: 'Co' })).toBe('Co');
  });
});

describe('PWA manifest name', () => {
  it('uses the app name when set (partner + "<app> Sales")', () => {
    expect(pwaAppName(BAJAJ, 'partner')).toBe('Bajaj Loyalty Club');
    expect(pwaAppName(BAJAJ, 'sales')).toBe('Bajaj Loyalty Club Sales');
    const m = buildManifest(BAJAJ, 'sales');
    expect(m.name).toBe('Bajaj Loyalty Club Sales');
    expect(m.short_name).toBe('Bajaj Loyalty Club Sales');
  });

  it('Deoleo (no appName) is unchanged: displayName-based', () => {
    expect(DEOLEO_CONFIG.branding.appName).toBeUndefined();
    const m = buildManifest(DEOLEO_CONFIG, 'partner');
    expect(m.name).toBe(DEOLEO_CONFIG.branding.displayName);
    expect(m.short_name).toBe(DEOLEO_CONFIG.branding.displayName);
    expect(pwaAppName(DEOLEO_CONFIG, 'sales')).toBe(`${DEOLEO_CONFIG.branding.displayName} Sales`);
  });
});

describe('root layout metadata (tab title)', () => {
  it('app name set → title is the app name; description keeps the company name', async () => {
    tenantConfig = BAJAJ;
    const { generateMetadata } = await import('@/app/layout');
    const md = await generateMetadata();
    expect(md.title).toEqual({ default: 'Bajaj Loyalty Club', template: '%s | Bajaj Loyalty Club' });
    expect(md.description).toContain('Bajaj Consumer Care Ltd');
  });

  it('no app name → the legacy title, byte-identical (Deoleo)', async () => {
    const { generateMetadata } = await import('@/app/layout');
    const md = await generateMetadata();
    const n = DEOLEO_CONFIG.branding.displayName;
    expect(md).toEqual({
      title: { default: `${n} Trade Loyalty Platform`, template: `%s | ${n} Loyalty` },
      description: `${n} Trade Loyalty Platform — earn points, track targets, and redeem rewards.`,
    });
  });
});

describe('sign-in layout heading', () => {
  async function renderAuth() {
    const { default: AuthLayout } = await import('@/app/auth/layout');
    render(await AuthLayout({ children: <div /> }));
  }

  it('shows the app name when set (no wordmark → text heading)', async () => {
    tenantConfig = { ...BAJAJ, branding: { ...BAJAJ.branding, wordmarkWhiteUrl: undefined } };
    await renderAuth();
    expect(screen.getAllByText('Bajaj Loyalty Club').length).toBeGreaterThan(0);
    expect(screen.queryByText('Bajaj Consumer Care Ltd')).toBeNull();
  });

  it('wordmark alt uses the app name', async () => {
    tenantConfig = { ...BAJAJ, branding: { ...BAJAJ.branding, wordmarkWhiteUrl: '/wm.png' } };
    await renderAuth();
    expect(screen.getAllByAltText('Bajaj Loyalty Club').length).toBeGreaterThan(0);
  });

  it('falls back to displayName when no app name (Deoleo)', async () => {
    tenantConfig = { ...DEOLEO_CONFIG, branding: { ...DEOLEO_CONFIG.branding, wordmarkWhiteUrl: undefined } };
    await renderAuth();
    expect(screen.getAllByText(DEOLEO_CONFIG.branding.displayName).length).toBeGreaterThan(0);
  });
});

describe('company-name copy keeps displayName', () => {
  it('KYC consent programme label is built from displayName, never the app name', () => {
    expect(loyaltyProgrammeLabel(BAJAJ.branding.displayName)).toBe('the Bajaj Consumer Care Ltd Loyalty Programme');
    // Guard: the KYC consent screen sources its name from branding.displayName.
    const src = fs.readFileSync(path.resolve(__dirname, '../../../app/sales/kyc/new/page.tsx'), 'utf8');
    expect(src).toMatch(/tenantDisplayName = useClientConfig\(\)\.branding\.displayName/);
    expect(src).not.toMatch(/appDisplayName|branding\.appName/);
  });
});
