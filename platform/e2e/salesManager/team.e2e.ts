import { test, expect } from '@playwright/test';
import { expectNoFabricatedData } from '../helpers/assert';

/**
 * SALES_ASM team roll-up — DATA-VISIBILITY `/sales/team` and sub-routes (Wave-0 manager-seed payoff).
 *
 * Auto-auth: this spec runs in the `salesManager` project (playwright.config.ts §93) which uses
 * ROLES.salesManager.storageStatePath — the ASM (seed-su-mgr, phone 9000000006, EMPASM1).
 *
 * ── DEMO ROLE-PICKER NOTE ──────────────────────────────────────────────────────────────────────
 * The sales shell stores the UI role in localStorage key `sales_role` (defaults to 'SO').  The
 * `hasTeamView` helper gates the Team nav item on `role !== 'SO' && role !== 'XSR'`.
 * Because we are logged in as SALES_ASM (backendRole), we set `sales_role=ASM` in localStorage
 * BEFORE navigating, so the nav reflects the real role.  Do NOT rely on the nav auto-reflecting
 * the backend role on first render — the picker is a demo artifact and the default ('SO') would
 * hide the Team link.  We drive the API directly in parallel for safety.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Seed ground truth:
 *   seed-su-mgr  — SALES_ASM, phone 9000000006, EMPASM1.
 *   seed-su-1    — SALES_SO (EMP001) reports directly to seed-su-mgr.
 *   O001 (CP001) + O002 (CP002) — assigned to seed-su-1.
 *
 * Routes under test:
 *   GET /api/sales/team                      → returns direct-report members (should include EMP001)
 *   GET /api/sales/team/:memberId            → detail for the SO (seed-su-1)
 *   GET /api/sales/team/:memberId/outlets    → outlets for the SO (O001, O002)
 *
 * FE routes:
 *   /sales/team                              → team list page
 *   /sales/team/:memberId                    → member detail
 *   /sales/team/:memberId/outlets            → member outlets
 *
 * What we assert:
 *   1. GET /api/sales/team returns the SO (EMP001) as a downline member (real roll-up).
 *   2. No fabricated member names appear (no invented SOs, no hardcoded demo data).
 *   3. GET /api/sales/team/:memberId (seed-su-1's DB id) returns detail with EMP001.
 *   4. GET /api/sales/team/:memberId/outlets returns O001 and O002.
 *   5. FE /sales/team page renders with the picker set to ASM (team list visible).
 */

const SO_EMPLOYEE_CODE = 'EMP001';
const ASSIGNED_OUTLET_CODES = ['O001', 'O002'];

/** Set the demo role-picker to ASM before loading any sales page. */
async function setSalesRolePickerToASM(page: import('@playwright/test').Page): Promise<void> {
  // Navigate to the app root first so we are on the correct origin (localStorage is origin-scoped).
  await page.goto('/sales/dashboard');
  await page.evaluate(() => {
    localStorage.setItem('sales_role', 'ASM');
    // Dispatch the storage event so React's useEffect listener picks it up without a reload.
    window.dispatchEvent(new StorageEvent('storage', { key: 'sales_role', newValue: 'ASM' }));
  });
}

test.describe('@salesManager team roll-up', () => {
  // ── API: /api/sales/team ───────────────────────────────────────────────────────

  test('GET /api/sales/team returns the SO (EMP001) as a direct-report downline member', async ({
    page,
  }) => {
    await page.goto('/sales/dashboard');
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'SALES_ASM must be logged in').toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    const res = await page.request.get('/api/sales/team', { headers: auth });
    expect(res.status(), 'GET /api/sales/team must succeed').toBe(200);

    const body = await res.json();
    expect(body.success, 'response must have success:true').toBe(true);

    const members: { id?: string; employeeId?: string; employeeCode?: string }[] =
      body.data?.members ?? [];
    expect(members.length, 'ASM must have at least one direct report').toBeGreaterThan(0);

    // The SO (EMP001) must be in the downline.
    const soMember = members.find(
      (m) =>
        m.employeeId === SO_EMPLOYEE_CODE ||
        m.employeeCode === SO_EMPLOYEE_CODE ||
        // The member object may carry the SO's DB user id or SalesUser id.
        // We fall back to checking whether the body text contains 'EMP001'.
        false,
    );

    // If not found by direct field match, stringify the body and check for the employee code.
    const bodyText = JSON.stringify(body);
    expect(
      soMember !== undefined || bodyText.includes(SO_EMPLOYEE_CODE),
      `SO with employee code ${SO_EMPLOYEE_CODE} must appear in ASM downline, got: ${bodyText.slice(0, 400)}`,
    ).toBe(true);
  });

  test('GET /api/sales/team must NOT return fabricated member names', async ({ page }) => {
    await page.goto('/sales/dashboard');
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'SALES_ASM must be logged in').toBeTruthy();

    const res = await page.request.get('/api/sales/team', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();

    // The seed generates real names. Fabricated demo members are listed here. If any appear in
    // the response the harness fails — they indicate demo data is leaking from a static mock.
    const FABRICATED_MEMBER_NAMES = [
      'Ravi Pillai', // demo SO persona (not seeded as a team member)
      'Anita Rao',   // demo ISR persona
      'Vikram Singh', // demo HO persona
    ];
    const bodyStr = JSON.stringify(body);
    for (const name of FABRICATED_MEMBER_NAMES) {
      expect(
        bodyStr.includes(name),
        `fabricated member name "${name}" must not appear in /api/sales/team response`,
      ).toBe(false);
    }
  });

  // ── API: /api/sales/team/:memberId ────────────────────────────────────────────

  test('GET /api/sales/team/:memberId returns the SO detail including EMP001', async ({ page }) => {
    await page.goto('/sales/dashboard');
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'SALES_ASM must be logged in').toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    // First get the list to find the SO's member id as returned by the API.
    const listRes = await page.request.get('/api/sales/team', { headers: auth });
    expect(listRes.status()).toBe(200);
    const listBody = await listRes.json();
    const members: { id: string }[] = listBody.data?.members ?? [];
    expect(members.length, 'need at least one member to drill into').toBeGreaterThan(0);

    // Use the first member (should be the SO).
    const memberId = members[0].id;
    expect(memberId, 'member id must be non-empty').toBeTruthy();

    const detailRes = await page.request.get(`/api/sales/team/${memberId}`, { headers: auth });
    expect(detailRes.status(), `GET /api/sales/team/${memberId} must succeed`).toBe(200);

    const detailBody = await detailRes.json();
    expect(detailBody.success, 'detail response must have success:true').toBe(true);

    const member = detailBody.data?.member;
    expect(member, 'member object must be present').toBeTruthy();

    // The detail must carry the employee code or a field that identifies EMP001.
    const memberStr = JSON.stringify(member);
    expect(
      memberStr.includes(SO_EMPLOYEE_CODE) || member?.employeeId === SO_EMPLOYEE_CODE,
      `detail for member ${memberId} must reference EMP001, got: ${memberStr.slice(0, 300)}`,
    ).toBe(true);
  });

  // ── API: /api/sales/team/:memberId/outlets ────────────────────────────────────

  test('GET /api/sales/team/:memberId/outlets returns O001 and O002 for the SO', async ({
    page,
  }) => {
    await page.goto('/sales/dashboard');
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token, 'SALES_ASM must be logged in').toBeTruthy();
    const auth = { Authorization: `Bearer ${token}` };

    // Get the member id from the team list.
    const listRes = await page.request.get('/api/sales/team', { headers: auth });
    expect(listRes.status()).toBe(200);
    const listBody = await listRes.json();
    const members: { id: string }[] = listBody.data?.members ?? [];
    expect(members.length).toBeGreaterThan(0);
    const memberId = members[0].id;

    const outletsRes = await page.request.get(`/api/sales/team/${memberId}/outlets`, {
      headers: auth,
    });
    expect(outletsRes.status(), `GET /api/sales/team/${memberId}/outlets must succeed`).toBe(200);

    const outletsBody = await outletsRes.json();
    expect(outletsBody.success, 'outlets response must have success:true').toBe(true);

    const outlets: { outletCode?: string }[] = outletsBody.data?.outlets ?? [];
    const codes = outlets.map((o) => o.outletCode ?? '');

    for (const expected of ASSIGNED_OUTLET_CODES) {
      expect(codes, `outlet ${expected} must appear in the SO's downline outlets`).toContain(
        expected,
      );
    }
  });

  // ── FE: /sales/team page ──────────────────────────────────────────────────────

  test('FE /sales/team renders the My Team heading (picker set to ASM)', async ({ page }) => {
    await setSalesRolePickerToASM(page);
    await page.goto('/sales/team');
    await page.waitForLoadState('networkidle');

    // With the picker set to ASM, hasTeamView('ASM') = true → the Team page renders
    // "My Team" instead of the "No team view" empty state.
    await expect(
      page.getByRole('heading', { name: /my team|national team/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('FE /sales/team renders no fabricated values (#40)', async ({ page }) => {
    await setSalesRolePickerToASM(page);
    await page.goto('/sales/team');
    await expectNoFabricatedData(page);
  });

  // ── FE: /sales/team/:memberId member detail ───────────────────────────────────

  test('FE /sales/team/:memberId renders the SO detail page without crashing', async ({ page }) => {
    await setSalesRolePickerToASM(page);

    // Resolve the member id via API first, then drive the FE page.
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const listRes = await page.request.get('/api/sales/team', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status()).toBe(200);
    const listBody = await listRes.json();
    const members: { id: string }[] = listBody.data?.members ?? [];
    expect(members.length, 'need at least one member to navigate to').toBeGreaterThan(0);
    const memberId = members[0].id;

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(`/sales/team/${memberId}`);
    await page.waitForLoadState('networkidle');

    const reactCrash = errors.find((e) => /something went wrong|minified react error/i.test(e));
    expect(reactCrash, `React crash on /sales/team/${memberId}: ${reactCrash}`).toBeUndefined();

    // Must render either the member name/profile or an error state — not a blank page.
    const body = await page.locator('body').innerText();
    expect(body.trim().length, 'member detail page must render some content').toBeGreaterThan(0);
  });

  // ── FE: /sales/team/:memberId/outlets ─────────────────────────────────────────

  test('FE /sales/team/:memberId/outlets renders the member\'s outlet list without crashing', async ({
    page,
  }) => {
    await setSalesRolePickerToASM(page);

    const token = await page.evaluate(() => localStorage.getItem('token'));
    const listRes = await page.request.get('/api/sales/team', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listRes.status()).toBe(200);
    const listBody = await listRes.json();
    const members: { id: string }[] = listBody.data?.members ?? [];
    expect(members.length).toBeGreaterThan(0);
    const memberId = members[0].id;

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(`/sales/team/${memberId}/outlets`);
    await page.waitForLoadState('networkidle');

    const reactCrash = errors.find((e) => /something went wrong|minified react error/i.test(e));
    expect(
      reactCrash,
      `React crash on /sales/team/${memberId}/outlets: ${reactCrash}`,
    ).toBeUndefined();

    // The page must render the outlet list heading or an empty-state, not a blank/crashed page.
    const heading = page.getByText(/outlets/i).first();
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });
});
