import { test, expect } from '@playwright/test';
import { cookieToken } from '../helpers/write';
import { ROLES } from '../fixtures/roles';
import { expectScopedOut } from '../helpers/assert';

/**
 * S4g / Wave-4 — GIFSY 194C cross-tenant TDS view.
 *
 * DISCOVERY: The 194C surface is NOT at a dedicated `/gifsy/tds` route.
 * It lives at `/admin/tds` (the shared admin TDS page), which GIFSY_ADMIN
 * accesses via the "assume-tenant" flow. The 194C TAB is shown only when
 * `session.role === 'GIFSY_ADMIN'` (the `isGifsy` flag in the FE).
 *
 * API (confirmed in api/src/tds/tds.controller.ts):
 *   GET /v1/admin/tds/194c?fy=<FY>   — GIFSY_ADMIN only, platform-wide
 *   GET /v1/admin/tds/194c/export?fy= — GIFSY_ADMIN only
 *
 * GIFSY must assume a tenant before calling /api/admin/tds/* (the admin routes
 * are tenant-scoped; GIFSY acquires a deoleo token via POST /api/auth/assume-tenant
 * and calls the endpoint cross-tenant using ?clientId override is not needed for
 * 194C — the endpoint ignores the JWT clientId and returns ALL tenants' data).
 *
 * Asserts:
 *  A1  GET /api/admin/tds/194c succeeds for GIFSY_ADMIN (assumes deoleo context).
 *  A2  The response carries the expected shape: section='194C', fyLabel, summary, rows[].
 *  A3  CLIENT_ADMIN is forbidden from GET /api/admin/tds/194c (403).
 *  A4  The /admin/tds page renders the 194C tab for GIFSY (FE role guard).
 *  A5  A CLIENT_ADMIN sees no 194C tab on /admin/tds (role-gated UI).
 *
 * NOTE: A dedicated `/gifsy/tds` FE route does not exist as of this writing
 * (no file found under platform/src/app/gifsy/tds/). The surface is the shared
 * /admin/tds page rendered in the GIFSY assumed-tenant context, so these specs
 * target that URL.
 */

/** Exchange the GIFSY session for a deoleo-scoped operator token. */
async function assumeDeoleoToken(page: import('@playwright/test').Page): Promise<string> {
  const gifsyToken = await cookieToken(page);
  expect(gifsyToken, 'gifsy session must be live').toBeTruthy();
  const res = await page.request.post('/api/auth/assume-tenant', {
    headers: { Authorization: `Bearer ${gifsyToken}`, 'Content-Type': 'application/json' },
    data: { clientId: 'deoleo' },
  });
  expect(res.status(), 'assume-tenant deoleo must succeed for GIFSY_ADMIN').toBeLessThan(300);
  const j = (await res.json()) as { data?: { accessToken?: string }; accessToken?: string };
  const token = (j.data as { accessToken?: string } | undefined)?.accessToken ?? j.accessToken;
  expect(token, 'assumed deoleo token must be in the response').toBeTruthy();
  return token!;
}

test.describe('@gifsy 194C cross-tenant TDS endpoint (S4g)', () => {
  // A1 + A2: GIFSY_ADMIN can call GET /api/admin/tds/194c
  test('GIFSY_ADMIN can call GET /api/admin/tds/194c and receives a valid response', async ({ page }) => {
    await page.goto('/gifsy');
    const tenantToken = await assumeDeoleoToken(page);

    const r = await page.request.get('/api/admin/tds/194c?fy=2025-26', {
      headers: { Authorization: `Bearer ${tenantToken}` },
    });
    expect(r.status(), 'GET /api/admin/tds/194c must return 200 for GIFSY_ADMIN').toBe(200);

    const body = (await r.json()) as {
      success: boolean;
      data?: {
        section: string;
        fyLabel: string;
        // serializeSummary194C returns totalLiabilityPaise (not liabilityPaise).
        // See api/src/tds/tds.controller.ts serializeSummary194C().
        summary: {
          fyLabel: string;
          totalBasePaise: string;
          totalLiabilityPaise: string;
          totalLiabilityNoThresholdPaise: string;
          totalDepositedPaise: string;
          totalOutstandingPaise: string;
          rowCount: number;
        };
        rows: unknown[];
      };
    };
    expect(body.success, 'response must be success=true').toBe(true);
    const data = body.data!;
    expect(data.section, 'section field must be 194C').toBe('194C');
    expect(data.fyLabel, 'fyLabel must be returned').toBeTruthy();
    expect(Array.isArray(data.rows), 'rows must be an array').toBe(true);
    // summary must be present with the correct numeric-string field (totalLiabilityPaise,
    // not liabilityPaise — the controller serialises as "total*Paise" for the 194C summary).
    expect(
      typeof data.summary.totalLiabilityPaise,
      'totalLiabilityPaise must be a string (BigInt serialised)',
    ).toBe('string');
  });

  // A3: CLIENT_ADMIN is forbidden
  test('CLIENT_ADMIN is forbidden from GET /api/admin/tds/194c (role guard)', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: ROLES.clientAdmin.storageStatePath });
    const page = await ctx.newPage();
    await page.goto('/admin/dashboard');
    const token = await cookieToken(page);
    expect(token, 'clientAdmin session must be live').toBeTruthy();

    const r = await page.request.get('/api/admin/tds/194c?fy=2025-26', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status(), 'CLIENT_ADMIN must be 403 on 194C endpoint').toBe(403);
    await ctx.close();
  });

  // A4: /admin/tds renders the 194C tab when logged in as GIFSY (assumed deoleo context)
  test('/admin/tds page shows the 194C tab for GIFSY_ADMIN', async ({ page }) => {
    // GIFSY must assume a tenant to access /admin/tds (which is a tenant admin route).
    await page.goto('/gifsy');
    const tenantToken = await assumeDeoleoToken(page);

    // Inject the assumed token into localStorage so the FE uses it for the admin route.
    await page.evaluate((tok) => localStorage.setItem('token', tok), tenantToken);

    await page.goto('/admin/tds');
    await expect(page.locator('body')).toBeVisible();

    // The 194C tab is rendered only for GIFSY_ADMIN (isGifsy=true in the FE).
    // Label: "194C — Contractor (Gifsy)"
    const tab194C = page.getByRole('button', { name: /194C.*Contractor.*Gifsy/i });
    await expect(tab194C).toBeVisible({ timeout: 8_000 });
  });

  // A5: CLIENT_ADMIN sees no 194C tab on /admin/tds
  test('CLIENT_ADMIN does NOT see the 194C tab on /admin/tds', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: ROLES.clientAdmin.storageStatePath });
    const page = await ctx.newPage();
    await page.goto('/admin/tds');
    await expect(page.locator('body')).toBeVisible();

    // If the page renders, ensure no 194C tab appears (isGifsy=false for CLIENT_ADMIN).
    await expect(
      page.getByRole('button', { name: /194C.*Contractor.*Gifsy/i }),
    ).toHaveCount(0);
    await ctx.close();
  });
});
