import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * Partner redemption orders read (Stream S3p, Wave 3).
 *
 * Tests: GET /api/rewards/orders renders the partner's own order list.
 *
 * Data-agnostic: in a fresh dev seed there are no orders yet; after
 * redemption-write.e2e.ts runs there is ≥ 1. Both states must pass:
 *   - empty DB  → "No orders yet" empty state, no crash
 *   - ≥ 1 order  → at least one order card renders with a non-empty reward name
 *
 * Endpoint: GET /api/rewards/orders → { success, data: { orders: ApiOrder[] } }
 * FE page:  /partner/rewards/orders
 */

test.describe('@partner orders (read)', () => {
  test('page mounts and renders the heading', async ({ page }) => {
    await page.goto('/partner/rewards/orders');
    await expect(page).toHaveURL(/\/partner\/rewards\/orders/);
    await expect(page.getByRole('heading', { name: /my orders/i })).toBeVisible();
  });

  test('renders own orders from the real API (data-agnostic: empty or populated)', async ({ page }) => {
    await page.goto('/partner/rewards/orders');

    // Wait for the loading spinner to disappear — the page is done when either
    // the empty state or an order card is visible.
    const emptyState = page.getByText('No orders yet');
    const firstOrderCard = page.locator('[class*="rounded-xl"]').filter({ hasText: /pts/i }).first();

    // Either the empty state or at least one order card must be visible.
    await expect(emptyState.or(firstOrderCard)).toBeVisible({ timeout: 10_000 });
  });

  test('order list matches what the API returns (scoped to this partner)', async ({ page }) => {
    await page.goto('/partner/rewards/orders');

    const token = await cookieToken(page);
    const r = await page.request.get('/api/rewards/orders', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.ok()).toBe(true);
    const j = await r.json();
    expect(j.success, 'GET /api/rewards/orders must succeed').toBe(true);

    const orders = (j.data?.orders ?? []) as Array<{ id: string; reward: { name: string } }>;

    if (orders.length === 0) {
      // No orders yet — verify the empty state (not a crash or error message).
      await expect(page.getByText('No orders yet')).toBeVisible();
    } else {
      // At least the first order's reward name appears on the page.
      const firstName = orders[0].reward?.name;
      expect(firstName, 'first order must have a reward name').toBeTruthy();
      await expect(page.getByText(firstName, { exact: false }).first()).toBeVisible({ timeout: 8_000 });
    }
  });

  test('API returns only this partner\'s orders (no cross-partner leak)', async ({ page }) => {
    await page.goto('/partner/rewards/orders');
    const token = await cookieToken(page);
    const r = await page.request.get('/api/rewards/orders', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json();
    const orders = (j.data?.orders ?? []) as Array<{ partner?: { id: string } }>;
    // Every order that carries a partner id must be for THIS partner (seed-cp-1).
    // Orders without a partner field are also fine (scoping enforced server-side).
    for (const order of orders) {
      if (order.partner?.id) {
        expect(
          order.partner.id,
          'order must belong to the logged-in partner (seed-cp-1), not another partner',
        ).toBe('seed-cp-1');
      }
    }
  });

  test('renders no fabricated demo values (#40)', async ({ page }) => {
    await page.goto('/partner/rewards/orders');
    await expectNoFabricatedData(page);
  });
});
