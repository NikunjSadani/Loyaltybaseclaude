import { test, expect } from '@playwright/test';
import { ROLES } from '../fixtures/roles';

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
    const token = await page.evaluate(() => localStorage.getItem('token'));
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
    const token = await p.evaluate(() => localStorage.getItem('token'));
    const r = await p.request.get('/api/kyc/review-queue', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status(), 'CLIENT_ADMIN is forbidden the Gifsy review-queue').toBe(403);
    await ctx.close();
  });
});
