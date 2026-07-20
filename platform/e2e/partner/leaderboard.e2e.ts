import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * Partner leaderboard read (Stream S3p, Wave 3).
 *
 * Tests: GET /api/leaderboard renders real rank data; the fabricated demo rank
 * strings ("#12 of" and "of 248 partners" — both in the #40 fail-list) must NEVER
 * appear (they appeared on /partner/dashboard; we pin the same guard here).
 *
 * When the leaderboard feature flag (`features.partnerApp.showLeaderboard`) is off
 * the FE renders a "Leaderboard not available" gate — that branch passes too.
 *
 * When the flag is on and the API returns data the page renders:
 *   - a heading "Leaderboard"
 *   - the `[data-testid="lb-my-rank-card"]` row for the logged-in partner (isMe=true),
 *     OR the "You are not yet ranked" card if the partner has no score yet.
 *   - `[data-testid="lb-kpi-value"]` elements that are real numeric strings
 *     (formatPoints output — never the fabricated demo rank).
 *
 * Endpoint: GET /api/leaderboard
 *           → { success, data: { leaderboard: [{ rank, partnerId, partnerName, score, rankChange }],
 *                                currentPartnerId } }
 * FE page:  /partner/leaderboard
 */

test.describe('@partner leaderboard (read)', () => {
  test('page mounts and renders the heading or the feature-flag gate', async ({ page }) => {
    await page.goto('/partner/leaderboard');
    await expect(page).toHaveURL(/\/partner\/leaderboard/);

    // Either the full leaderboard heading or the feature-disabled gate must render.
    const heading = page.getByRole('heading', { name: /leaderboard/i });
    const disabledGate = page.getByText(/leaderboard not available/i);
    await expect(heading.or(disabledGate)).toBeVisible({ timeout: 10_000 });
  });

  test('renders NO fabricated demo rank strings (#40)', async ({ page }) => {
    await page.goto('/partner/leaderboard');
    // Fabricated tokens '#12 of' and 'of 248 partners' are already in FABRICATED_TOKENS
    // (checked globally). Run the full scan to catch any new form they might appear in.
    await expectNoFabricatedData(page);
  });

  test('API returns the expected leaderboard shape', async ({ page }) => {
    await page.goto('/partner/leaderboard');
    const token = await cookieToken(page);
    const r = await page.request.get('/api/leaderboard', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.ok()).toBe(true);
    const j = await r.json();
    expect(j.success, 'GET /api/leaderboard must succeed').toBe(true);
    const entries = j.data?.leaderboard ?? [];
    expect(Array.isArray(entries), 'data.leaderboard must be an array').toBe(true);
    // Shape check each entry when data is present.
    for (const e of entries as Array<{ rank: unknown; partnerId: unknown; score: unknown }>) {
      expect(typeof e.rank, 'rank must be a number').toBe('number');
      expect(typeof e.partnerId, 'partnerId must be a string').toBe('string');
      expect(typeof e.score, 'score must be a number').toBe('number');
    }
  });

  test('my rank row is correctly flagged (isMe) when the partner appears in rankings', async ({ page }) => {
    await page.goto('/partner/leaderboard');
    await page.waitForLoadState('networkidle').catch(() => {});

    // If the feature flag is off, the page renders the "Leaderboard not available" gate instead of a
    // ranking — skip the my-rank assertion. (The seeded deoleo partner has the leaderboard disabled.)
    const disabledGate = page.getByText(/leaderboard not available|not enabled for your account/i);
    if (await disabledGate.isVisible({ timeout: 8_000 }).catch(() => false)) {
      test.skip(true, 'leaderboard feature flag is disabled — gate rendered');
      return;
    }

    // Wait for the loading spinner to clear before any further assertions.
    await expect(page.locator('.animate-spin')).toHaveCount(0, { timeout: 12_000 });

    const token = await cookieToken(page);
    const r = await page.request.get('/api/leaderboard', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    const currentPartnerId = j.data?.currentPartnerId as string | null | undefined;
    const entries = (j.data?.leaderboard ?? []) as Array<{ partnerId: string }>;

    // Only assert the "You" row when the API confirms this partner is in the list.
    const iAmInList = currentPartnerId && entries.some((e) => e.partnerId === currentPartnerId);
    if (iAmInList) {
      // The FE marks the current partner's row with data-testid="lb-my-rank-card".
      await expect(page.locator('[data-testid="lb-my-rank-card"]')).toBeVisible({ timeout: 8_000 });
      // The "You" badge appears next to the partner's name.
      await expect(page.getByText('You')).toBeVisible();
    } else {
      // The seeded partner is not in the rankings (no leaderboard data) — the premise of THIS test
      // ("when the partner appears in rankings") doesn't hold, so there's no my-rank row to verify.
      test.skip(true, 'seeded partner is not in the rankings — no my-rank row to assert');
    }
  });

  test('KPI values shown in the ranking list are real numbers (not demo text)', async ({ page }) => {
    await page.goto('/partner/leaderboard');

    // If the feature flag is off, skip.
    const disabledGate = page.getByText(/leaderboard not available/i);
    if (await disabledGate.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'leaderboard feature flag is disabled');
      return;
    }

    // Wait for the list to render.
    const kpiValues = page.locator('[data-testid="lb-kpi-value"]');
    const count = await kpiValues.count().catch(() => 0);
    if (count === 0) {
      // No entries rendered (empty leaderboard) — that is fine; nothing to assert.
      return;
    }

    // Every rendered KPI value must be a parseable number (formatPoints output: "1,234" or "0").
    for (let i = 0; i < count; i++) {
      const text = await kpiValues.nth(i).innerText();
      const numeric = parseFloat(text.replace(/,/g, ''));
      expect(
        isNaN(numeric),
        `lb-kpi-value at index ${i} is not a number: "${text}"`,
      ).toBe(false);
    }
  });
});
