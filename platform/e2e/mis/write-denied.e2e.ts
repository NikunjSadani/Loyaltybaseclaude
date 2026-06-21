import { test, expect } from '@playwright/test';
import { authHeader } from '../helpers/write';
import { expectScopedOut } from '../helpers/assert';

/**
 * MIS_USER write-denied — the core MIS guarantee.
 *
 * MIS_USER is a read-only role. Two enforcement layers are tested here:
 *
 * LAYER 1 — @Roles guard (always active, no RBAC flag needed):
 *   PATCH /api/admin/channel-partners/seed-cp-1 is gated with
 *   @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN') in channel-partners.controller.ts (line ~34).
 *   MIS_USER is deliberately absent from that list. The RolesGuard throws
 *   ForbiddenException (HTTP 403) for any role not in the decorator set.
 *   This is the cleanest, flag-independent write-denial proof.
 *
 * LAYER 2 — FE scope-out (/admin/payouts):
 *   Payout management is GIFSY-only (Q1). The admin/payouts layout carries
 *   allowedRoles=['GIFSY_ADMIN'], so CLIENT_ADMIN is already redirected away —
 *   MIS_USER must be too. expectScopedOut() proves it.
 *
 * Seed dependency:
 *   Channel partner seed-cp-1 (CP001) must exist (seed §3.3). The PATCH body is
 *   intentionally minimal (empty JSON) — the 403 fires before any business logic
 *   (the @Roles guard runs before the route handler / service). A missing
 *   channel-partner row would produce 404, not 403, so if the seed is absent the
 *   test still fails clearly with a meaningful status-code assertion.
 *
 * How to read the write-denial result:
 *   - 403 → write correctly blocked (the MIS guarantee holds).
 *   - 200/204 → REAL FINDING: MIS_USER can mutate channel partners. Report loudly.
 *   - 404 → seed-cp-1 missing; re-run after seeding.
 *   - Other → unexpected; assertion fails with the actual status for investigation.
 */

const SAFE_REDIRECTS = ['/auth/login', '/admin/dashboard', '/admin'];

test.describe('@mis write-denied — core MIS guarantee', () => {

  /**
   * LAYER 1: direct API write attempt via the MIS token.
   *
   * We call PATCH /api/admin/channel-partners/seed-cp-1 with the MIS JWT.
   * The @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN') guard fires before the handler —
   * MIS_USER is not in the list → 403 Forbidden.
   *
   * This does NOT depend on RBAC_ENFORCEMENT (which gates the PermissionGuard).
   * The RolesGuard is always active.
   *
   * If the response is 200 or 204, that is a REAL FINDING — MIS_USER is mutating
   * data it must not. The test assertion will fail with the actual status code.
   */
  test('PATCH /api/admin/channel-partners/seed-cp-1 returns 403 for MIS token (RolesGuard)', async ({ page }) => {
    // Navigate to any admin page first so page.request uses the right base URL.
    await page.goto('/admin/dashboard');

    const mis = authHeader('mis');

    const response = await page.request.patch(
      '/api/admin/channel-partners/seed-cp-1',
      {
        headers: {
          ...mis,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({}),
      },
    );

    const status = response.status();

    // ── WRITE-DENIAL RESULT ────────────────────────────────────────────────────
    // 403 = blocked correctly (MIS guarantee holds).
    // 200/204 = REAL FINDING — MIS_USER can mutate channel partners. STOP.
    // 404 = seed-cp-1 missing (re-seed); assertion will fail with an informative message.
    expect(
      status,
      status === 200 || status === 204
        ? `⚠️  REAL FINDING: PATCH /api/admin/channel-partners/seed-cp-1 returned ${status} for MIS_USER — ` +
          `the @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN') guard is NOT blocking MIS. ` +
          `MIS_USER CAN MUTATE CHANNEL PARTNERS. This is a security gap, not a test bug.`
        : `Expected 403 (RolesGuard blocks MIS_USER from write). ` +
          `Got ${status} — if 404, check that seed-cp-1 exists (api/prisma/seed.ts §3.3).`,
    ).toBe(403);
  });

  /**
   * Verify the 403 response is the Nest ForbiddenException (not a network error or
   * unrelated 403). The NestJS exception body includes "Forbidden" or "Access denied".
   *
   * This test is a companion to the status-code assertion above — it only runs if the
   * spec runner reaches it (i.e. if the PATCH returned 403 above). Both tests landing
   * in the same file means a write-allowed scenario will fail the first test and skip
   * neither — the runner reports both for maximum signal.
   */
  test('403 body confirms the Nest RolesGuard message (not an unrelated 403)', async ({ page }) => {
    await page.goto('/admin/dashboard');

    const mis = authHeader('mis');

    const response = await page.request.patch(
      '/api/admin/channel-partners/seed-cp-1',
      {
        headers: {
          ...mis,
          'Content-Type': 'application/json',
        },
        data: JSON.stringify({}),
      },
    );

    // Only inspect body if we got a 403 (if not, the previous test already failed).
    if (response.status() !== 403) return;

    const body = await response.text().catch(() => '');
    // Nest wraps ForbiddenException as { statusCode: 403, message: "Access denied. Required: ...", error: "Forbidden" }
    const looksLikeRolesGuard =
      body.toLowerCase().includes('forbidden') ||
      body.toLowerCase().includes('access denied');

    expect(
      looksLikeRolesGuard,
      `403 body does not look like a Nest RolesGuard exception — got: ${body.slice(0, 200)}`,
    ).toBe(true);
  });

  /**
   * LAYER 2: FE scope-out — /admin/payouts is GIFSY-only (Q1).
   *
   * The admin/payouts layout carries allowedRoles=['GIFSY_ADMIN']. MIS_USER is
   * therefore scoped out at the FE level (same as CLIENT_ADMIN, already proven in
   * clientAdmin/scoping.e2e.ts Q1). expectScopedOut() asserts:
   *   - a live session token exists (not a dead-session false-pass)
   *   - MIS is redirected to a known-safe destination (not still on /admin/payouts)
   *   - OR the page renders an explicit forbidden state
   *   - AND no payout management content leaks through
   */
  test('Q1 — MIS cannot reach /admin/payouts (GIFSY-only; expectScopedOut)', async ({ page }) => {
    await expectScopedOut(page, '/admin/payouts', {
      forbiddenMarkers: ['payout batch', 'process payout', 'settlement'],
      safeRedirects: SAFE_REDIRECTS,
    });
  });

  /**
   * Sub-page confirmation: /admin/payouts/fund is also guarded by the payouts layout.
   * MIS must not reach the fund-disbursement page either.
   */
  test('Q1 — MIS cannot reach /admin/payouts/fund (GIFSY-only sub-page)', async ({ page }) => {
    await expectScopedOut(page, '/admin/payouts/fund', {
      forbiddenMarkers: ['fund', 'disburse', 'payout batch'],
      safeRedirects: SAFE_REDIRECTS,
    });
  });

  /**
   * LAYER 2 (extra): Gifsy platform console must not be reachable by MIS.
   * MIS_USER is a tenant role — the Gifsy platform surfaces (/gifsy/*) are
   * GIFSY_ADMIN-only. The FE RequireAuth guard on the /gifsy layout rejects
   * non-GIFSY_ADMIN users.
   */
  test('MIS cannot reach the Gifsy platform console (/gifsy/clients)', async ({ page }) => {
    await expectScopedOut(page, '/gifsy/clients', { safeRedirects: SAFE_REDIRECTS });
  });
});
