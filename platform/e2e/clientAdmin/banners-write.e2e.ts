import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { uniqueMarker } from '../helpers/persist';

/**
 * W14 — Admin banner create write-persistence.
 *
 * Proves:
 *   POST /api/admin/banners creates a new banner → fresh GET /api/admin/banners
 *   shows the banner by its unique title.
 *
 * Backend controller: api/src/admin-programs/banners.controller.ts (BannersController)
 *   POST /v1/admin/banners  (CLIENT_ADMIN, engagement:manage_banners)
 *   GET  /v1/admin/banners  (CLIENT_ADMIN, engagement:read)
 * FE proxy: /api/admin/banners/* → /v1/admin/banners/*
 *
 * IMPORTANT: GET /v1/admin/banners for non-GIFSY callers filters to ACTIVE,
 * non-expired banners only (banners.service.ts line ~25). The created banner
 * defaults to INACTIVE, so a non-GIFSY GET will not see it. We explicitly set
 * status='ACTIVE' in the create payload so the CLIENT_ADMIN re-read will include it.
 *
 * Idempotent: each run creates a distinct banner (title contains Date.now()).
 */

test.describe('@clientAdmin banner create write-persistence (W14)', () => {
  test('create a banner (ACTIVE) → fresh GET shows it by title', async ({ page }) => {
    await page.goto('/admin/banners');

    const token = await cookieToken(page);
    expect(token, 'CLIENT_ADMIN must be logged in (storageState)').toBeTruthy();

    const auth = { Authorization: `Bearer ${token}` };

    const bannerTitle = uniqueMarker('E2E-Banner');

    // ── Step 1: CREATE ──────────────────────────────────────────────────────────
    const createResult = await page.evaluate(
      async ({ tok, title }) => {
        const res = await fetch('/api/admin/banners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body: JSON.stringify({
            title,
            // A valid URL is required (IsUrl validation).
            imageUrl: 'https://placehold.co/800x200/png',
            position: 'HOME_TOP',
            // Set ACTIVE so the CLIENT_ADMIN re-read (which filters non-GIFSY to ACTIVE
            // banners) can see the new banner.
            status: 'ACTIVE',
            sortOrder: 0,
          }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      { tok: token!, title: bannerTitle },
    );

    expect(
      [200, 201],
      `POST /api/admin/banners returned ${createResult.status}: ${JSON.stringify(createResult.body)}`,
    ).toContain(createResult.status);

    const created = (createResult.body?.data ?? createResult.body) as
      | { banner?: { id: string; title: string } }
      | undefined;
    const newBanner = created?.banner;
    expect(newBanner?.id, 'POST must return the created banner with an id').toBeTruthy();
    expect(newBanner?.title, 'POST must echo the banner title').toBe(bannerTitle);
    const newId = newBanner!.id;

    // ── Step 2: PERSISTENCE — fresh GET must include the new banner ─────────────
    const readBanners = async (): Promise<{ id: string; title: string }[]> => {
      const r = await page.request.get('/api/admin/banners', { headers: auth });
      expect(r.status(), 'GET /api/admin/banners must return 200').toBe(200);
      const j = await r.json();
      return (j.data?.banners ?? j.banners ?? []) as { id: string; title: string }[];
    };

    await expect
      .poll(readBanners, {
        timeout: 10_000,
        message: `New banner "${bannerTitle}" (id=${newId}) must appear in fresh GET /api/admin/banners`,
      })
      .toEqual(
        expect.arrayContaining([expect.objectContaining({ id: newId, title: bannerTitle })]),
      );

    // Final assertion — unambiguous by unique title.
    const allBanners = await readBanners();
    const found = allBanners.find((b) => b.id === newId && b.title === bannerTitle);
    expect(found, `Banner "${bannerTitle}" (id=${newId}) must be findable in the fresh list`).toBeDefined();
  });
});
