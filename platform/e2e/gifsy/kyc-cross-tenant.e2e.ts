import { test, expect } from '@playwright/test';
import { ROLES } from '../fixtures/roles';
import { expectScopedOut } from '../helpers/assert';
import { cookieToken } from '../helpers/write';

/**
 * A1 / gap #38 — the Gifsy platform operator must see + act on KYC across ALL brands.
 * Before the fix, every KYC lookup was scoped to the caller's clientId ('gifsy'), so the
 * operator's review-queue was empty and getOne 404'd on any tenant record. This asserts
 * the cross-tenant read at runtime through the real :3000 proxy with a real GIFSY session:
 * the review-queue spans >1 brand (deoleo's seed-kyc-1 AND clientb's seed-kyc-b1), and each
 * entry carries its own clientId so the UI can label/filter by brand.
 *
 * Seeded PENDING_GIFSY records: seed-kyc-1 (deoleo), seed-kyc-b1 (clientb).
 */
test.describe('@gifsy KYC cross-tenant access (A1 / #38)', () => {
  test('the review-queue spans multiple brands, each tagged with its own clientId', async ({ page }) => {
    await page.goto('/admin/kyc/approvals');
    const token = await cookieToken(page);
    expect(token, 'gifsy must be logged in (storageState)').toBeTruthy();

    const r = await page.request.get('/api/kyc/review-queue', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status()).toBe(200);
    const entries = (await r.json()).data?.entries ?? [];

    // Every entry exposes its brand; the queue spans BOTH seeded brands (was empty pre-fix).
    expect(entries.every((e: { clientId?: string }) => !!e.clientId), 'each entry has a clientId').toBe(true);
    const brands = new Set(entries.map((e: { clientId: string }) => e.clientId));
    expect(brands.has('deoleo'), 'sees deoleo KYC').toBe(true);
    expect(brands.has('clientb'), 'sees clientb KYC (cross-tenant)').toBe(true);
    expect(brands.size, 'review-queue spans >1 brand').toBeGreaterThan(1);
  });

  test('a tenant admin is refused the Gifsy-only review-queue (role matrix)', async ({ browser }) => {
    // A deoleo CLIENT_ADMIN must NOT be able to call the cross-tenant operator queue.
    const ctx = await browser.newContext({ storageState: ROLES.clientAdmin.storageStatePath });
    const p = await ctx.newPage();
    await p.goto('/admin/dashboard');
    const token = await cookieToken(p);
    const r = await p.request.get('/api/kyc/review-queue', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status(), 'CLIENT_ADMIN is forbidden the Gifsy review-queue').toBe(403);
    await ctx.close();
  });

  // ── PAGE-level — the rendered review workspace lists multi-tenant rows ────────────
  // The API-level assertions above prove the queue spans both brands; this proves the
  // GIFSY operator SEES them in the rendered /admin/kyc/approvals workspace at runtime.
  test('the rendered review workspace lists rows from BOTH tenants, tagged by brand', async ({ page }) => {
    await page.goto('/admin/kyc/approvals');
    await expect(page.getByRole('heading', { name: /KYC Approvals/i })).toBeVisible();

    // clientb's distinctively-named seeded outlet is a row in the queue (cross-tenant read).
    // .first(): the name legitimately renders in both the queue button and the auto-selected
    // detail panel, so match the first occurrence — presence is what proves the cross-tenant read.
    await expect(page.getByText('Zenith Trading Co').first()).toBeVisible();

    // The brand-filter <select> only renders when the queue spans >1 brand (the Gifsy view, #38),
    // and exposes BOTH brands as options — proof the rendered list is multi-tenant, not single-scope.
    const brandFilter = page.getByRole('combobox', { name: /filter queue by brand/i });
    await expect(brandFilter).toBeVisible();
    await expect(brandFilter.getByRole('option', { name: /deoleo/i })).toHaveCount(1);
    await expect(brandFilter.getByRole('option', { name: /clientb/i })).toHaveCount(1);

    // Each multi-brand row carries a brand chip — both tenant slugs are visible in the queue.
    const queue = page.locator('button', { has: page.getByText('Zenith Trading Co') }).first();
    await expect(queue).toContainText('clientb');
  });

  // A CLIENT_ADMIN must NOT see the other tenant's rows in the rendered workspace. The FE route guard
  // admits GIFSY_ADMIN only, so a tenant admin is scoped out (redirect to a safe page or an explicit
  // forbidden state) and clientb's distinctive name must never appear for them.
  test('a tenant admin does NOT see cross-tenant rows in the workspace (role matrix)', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: ROLES.clientAdmin.storageStatePath });
    const p = await ctx.newPage();
    await expectScopedOut(p, '/admin/kyc/approvals', { forbiddenMarkers: ['Zenith Trading Co'] });
    await ctx.close();
  });
});
