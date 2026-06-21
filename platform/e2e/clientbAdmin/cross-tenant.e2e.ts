import { test, expect } from '@playwright/test';
import { authHeader } from '../helpers/write';

/**
 * REVERSE cross-tenant isolation (#52 bidirectional, unblocked by #39). The clientb admin logs in
 * via the dev clientId override and must see ONLY clientb's data — never deoleo's. Together with
 * the deoleo→clientb spec (clientAdmin/cross-tenant), this proves isolation in BOTH directions.
 *
 * S4n additions: extend beyond the outlets API + dashboard count to cover more data-bearing pages
 * (KYC list, tickets, schemes) and use richer DEOLEO_MARKERS pulled directly from seed.ts so that
 * any tenant-filter regression is caught by the real seeded strings, not just code/id fields.
 *
 * Seed sources for DEOLEO_MARKERS:
 *   - 'Deoleo Demo Wholesale Mart'  → seed.ts §3.3 CP001 businessName / outlet name
 *   - 'Deoleo Demo Retail Store'    → seed.ts §3.3 CP002 businessName / outlet name
 *   - 'CP001', 'CP002', 'CP003'     → deoleo partner codes
 *   - 'O001', 'O002', 'O003'        → deoleo outlet codes
 *   - 'Ravi Kumar'                  → seed.ts §3.3 CP001 ownerName
 *   - 'Sunita Sharma'               → seed.ts §3.3 CP002 ownerName
 *   - 'Meena Iyer'                  → seed.ts §3.8 CP003 ownerName
 *   - 'DEO-0001'                    → seed.ts §3.4c deoleo ticket number
 *   - 'Demo Visibility Scheme'      → seed.ts §3.8 deoleo scheme name
 *   - 'DEMO-VIS'                    → seed.ts §3.8 deoleo scheme code
 */

// Core markers — uniquely deoleo strings never present in clientb data.
const DEOLEO_MARKERS = [
  'Deoleo Demo Wholesale Mart',
  'Deoleo Demo Retail Store',
  'Deoleo Demo Distributor',
  'CP001', 'CP002', 'CP003',
  'O001', 'O002', 'O003',
  'Ravi Kumar',
  'Sunita Sharma',
  'Meena Iyer',
];

test.describe('@clientbAdmin reverse cross-tenant isolation (#52)', () => {
  test('the /api/admin/outlets response has clientb rows, NOT deoleo (backend scoping, reverse)', async ({ page }) => {
    const resP = page.waitForResponse(
      (r) => r.url().includes('/api/admin/outlets') && r.request().method() === 'GET',
      { timeout: 15_000 },
    );
    await page.goto('/admin/users/outlets');
    const res = await resP;
    const text = await res.text();

    // Sanity: the response carries clientb's own data (so the leak-check is meaningful).
    expect(text).toContain('OB001'); // clientb's outlet code

    for (const m of DEOLEO_MARKERS) {
      expect(
        text.includes(m),
        `TENANT LEAK: deoleo "${m}" returned by /api/admin/outlets for a clientb admin`,
      ).toBe(false);
    }
  });

  test('dashboard active-partners count is clientb-scoped (1, not 3)', async ({ page }) => {
    await page.goto('/admin/dashboard');
    const value = page
      .locator('p', { hasText: /^Total Active Partners$/ })
      .locator('xpath=preceding-sibling::p[1]');
    // clientb has exactly 1 partner (CPB001); a cross-tenant leak would show 3 (incl. deoleo's 2).
    await expect(value).toHaveText('1', { timeout: 10_000 });
  });

  // S4n — these assert the REAL list endpoints (the FE calls /api/kyc, /api/tickets, /api/schemes,
  // /api/visibility/submissions — NOT /api/admin/*, which 404). Direct authenticated reads as the
  // clientb admin are deterministic (no dependence on which request a page happens to fire) and
  // catch a leak by the seeded deoleo *ids* the JSON actually carries. Markers chosen to match the
  // real payload shape (ids, not display codes): a deoleo row appearing here = a backend scope leak.

  test('/api/kyc returns ONLY clientb KYC, never deoleo (backend tenant scoping)', async ({ page }) => {
    const res = await page.request.get('/api/kyc', { headers: authHeader('clientbAdmin') });
    expect(res.status(), 'clientb admin can read its own KYC list').toBe(200);
    const text = await res.text();
    // Positive sanity: clientb sees its OWN submission (seed-kyc-b1) — proves we read real data.
    expect(text, 'clientb must see its own KYC row').toContain('seed-kyc-b1');
    for (const m of ['seed-kyc-1', 'seed-kyc-2', 'seed-kyc-3', 'seed-cp-1', 'seed-cp-3', 'seed-deoleo-partner', 'Ravi Kumar', 'Meena Iyer']) {
      expect(text.includes(m), `TENANT LEAK: deoleo "${m}" in /api/kyc for a clientb admin`).toBe(false);
    }
  });

  test('/api/tickets returns NO deoleo tickets for a clientb admin', async ({ page }) => {
    const res = await page.request.get('/api/tickets', { headers: authHeader('clientbAdmin') });
    expect(res.status()).toBe(200);
    const text = await res.text();
    // DEO-0001 (seed-ticket-1) is the only seeded ticket and belongs to deoleo.
    for (const m of ['DEO-0001', 'seed-ticket-1', 'Payout not received for April']) {
      expect(text.includes(m), `TENANT LEAK: deoleo ticket "${m}" in /api/tickets for a clientb admin`).toBe(false);
    }
  });

  test('/api/schemes returns NO deoleo schemes for a clientb admin', async ({ page }) => {
    const res = await page.request.get('/api/schemes', { headers: authHeader('clientbAdmin') });
    expect(res.status()).toBe(200);
    const text = await res.text();
    for (const m of ['DEMO-VIS', 'seed-scheme-1', 'Demo Visibility']) {
      expect(text.includes(m), `TENANT LEAK: deoleo scheme "${m}" in /api/schemes for a clientb admin`).toBe(false);
    }
  });

  test('/api/visibility/submissions returns NO deoleo programs for a clientb admin', async ({ page }) => {
    const res = await page.request.get('/api/visibility/submissions', { headers: authHeader('clientbAdmin') });
    expect(res.status()).toBe(200);
    const text = await res.text();
    // VP001 (seed-vp-1) "Storefront Branding" is deoleo-only; deoleo partner submissions reference it.
    for (const m of ['VP001', 'seed-vp-1', 'Storefront Branding']) {
      expect(text.includes(m), `TENANT LEAK: deoleo visibility "${m}" in /api/visibility/submissions for a clientb admin`).toBe(false);
    }
  });
});
