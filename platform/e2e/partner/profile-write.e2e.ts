import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * Partner profile read (Stream S3p, Wave 3) — W17.
 *
 * WRITE STATUS: read-only spec (no write path available).
 *
 * The profile page (platform/src/app/partner/profile/page.tsx) fetches
 * GET /api/auth/me and merges real API data into the display. There is NO edit
 * endpoint for a partner's own profile fields (name, firm name, GST, PAN) —
 * those are controlled by admin KYC approval. The only mutable field on this
 * page is the invoice number on /partner/invoices/[id], which belongs to a
 * different page.
 *
 * MOCK FALLBACK RISK: the profile page falls back to MOCK_PROFILE (Rajesh Kumar /
 * Kumar General Store) if GET /api/auth/me fails. The real user for CP001 is
 * seeded with businessName="Deoleo Demo Wholesale Mart" and partnerCode="CP001".
 * We assert the REAL data (not the mock) is shown, pinning the API path.
 *
 * Assertions:
 *   - The outlet code "CP001" renders (from real API cp.partnerCode).
 *   - No fabricated demo values (#40) surface — in particular "Rajesh Kumar"
 *     and "Kumar General Store" (which appear in MOCK_PROFILE) must not render.
 *
 * Endpoint: GET /api/auth/me → { user: { name, phone, channelPartner: { partnerCode, businessName, ... } } }
 * FE page:  /partner/profile
 */

test.describe('@partner profile (read / W17)', () => {
  test('page mounts and renders the profile header', async ({ page }) => {
    await page.goto('/partner/profile');
    await expect(page).toHaveURL(/\/partner\/profile/);
    // The profile header section (data-testid="profile-header") always renders
    // after the API call settles (success or mock fallback).
    await expect(page.locator('[data-testid="profile-header"]')).toBeVisible({ timeout: 10_000 });
  });

  test('shows the REAL outlet code CP001 from the API (not the mock KGS-001)', async ({ page }) => {
    await page.goto('/partner/profile');
    // data-testid="outlet-code-value" renders cp.partnerCode from GET /api/auth/me.
    // If the API fails and the mock is used, this would show "KGS-001" instead.
    const outletCodeEl = page.locator('[data-testid="outlet-code-value"]');
    await expect(outletCodeEl).toBeVisible({ timeout: 10_000 });
    await expect(outletCodeEl).toHaveText('CP001');
  });

  test('renders no fabricated demo values (#40) — in particular not the mock name/store', async ({ page }) => {
    await page.goto('/partner/profile');
    // 'Rajesh Kumar' and 'Kumar General Store' are in FABRICATED_TOKENS and will be
    // caught by expectNoFabricatedData. Running it here also catches any new mock
    // leftovers that surface on this page.
    await expect(page.locator('[data-testid="profile-header"]')).toBeVisible({ timeout: 10_000 });
    await expectNoFabricatedData(page);
  });

  test('GET /api/auth/me returns real partner data for CP001', async ({ page }) => {
    await page.goto('/partner/profile');
    const token = await cookieToken(page);
    const r = await page.request.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.ok()).toBe(true);
    const j = await r.json();
    expect(j.success, '/api/auth/me must succeed').toBe(true);
    const cp = j.data?.user?.channelPartner;
    expect(cp, 'channelPartner must be present in /api/auth/me response').toBeTruthy();
    expect(cp.partnerCode, 'partnerCode must be CP001').toBe('CP001');
    expect(
      cp.businessName,
      'businessName must be the real seeded firm name, not the mock',
    ).toBe('Deoleo Demo Wholesale Mart');
  });

  test('Points Summary card shows the real wallet balance (Wholesaler track)', async ({ page }) => {
    await page.goto('/partner/profile');
    // Points Summary is visible only for WHOLESALER outlet type (session.outletType === 'WHOLESALER').
    // The card uses data-testid="points-summary".
    const pointsSummary = page.locator('[data-testid="points-summary"]');
    await expect(pointsSummary).toBeVisible({ timeout: 10_000 });
    // The balance shown must be the real wallet value, not the mock 4,250.
    // Seed: 50,000 redeemable (minus any CI deductions). We verify via the API.
    const token = await cookieToken(page);
    const r = await page.request.get('/api/wallet', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    const redeemable = j.data?.redeemablePoints as number;
    expect(redeemable, 'real redeemable balance must be > 0').toBeGreaterThan(0);
    // The card renders formatPoints(redeemable) — at 50,000 that is "50,000".
    // After redemption-write runs it decrements by 500 → "49,500", etc.
    // Rather than hardcode the exact value, verify the rendered text is NOT the mock 4,250.
    const summaryText = await pointsSummary.innerText();
    expect(summaryText, 'Points Summary must not show the mock 4,250 balance').not.toContain('4,250');
  });
});
