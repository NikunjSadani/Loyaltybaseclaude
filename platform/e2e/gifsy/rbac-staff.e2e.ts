import { test, expect } from '@playwright/test';

/**
 * RBAC Option-X P3 — the Gifsy control panel, end-to-end through the real UI.
 *
 * Drives the owner (GIFSY_ADMIN) through /gifsy/roles + /gifsy/staff:
 *  1. Role editor renders; the reserved-permission "warn-to-grant" gate works (a reserved
 *     checkbox is disabled until the explicit ack, which reveals the warning + enables it).
 *  2. Create a real role granting a reserved permission (proves the allowReserved Lock-1 path
 *     end-to-end: UI ack → allowReserved:true → backend accepts) plus a benign read.
 *  3. Staff panel renders; add a staff member assigned that role; the row shows the role name.
 *  4. Clean up the created staff + role via the authenticated API (page.request shares cookies),
 *     so the run is idempotent (LOCAL against gifsy_dev, STAGING against the operator console).
 *
 * Unique per-run names/phone so re-runs never collide. Runs under the `gifsy` project (reuses the
 * persisted GIFSY_ADMIN session). Staging: E2E_ENV=staging E2E_BASE_URL=https://uat.app.gifsy.in
 * E2E_OTP_STRATEGY=fixed E2E_OTP=123456.
 */

const RUN = Date.now();
const ROLE_NAME = `E2E-RBAC Ops ${RUN}`;
const STAFF_NAME = `E2E-RBAC Staff ${RUN}`;
const STAFF_PHONE = `9${String(RUN).slice(-9)}`; // 10 digits, starts 9, collision-improbable

test.describe('@gifsy RBAC control panel (P3 end-to-end)', () => {
  test('role editor + staff panel: create role (reserved warn-to-grant), add staff, verify, cleanup', async ({
    page,
  }) => {
    // ── ROLE EDITOR: page renders ──────────────────────────────────────────────
    await page.goto('/gifsy/roles');
    await expect(page.getByRole('heading', { name: 'Gifsy Roles' })).toBeVisible({ timeout: 15_000 });

    // ── ROLE EDITOR: open create modal; verify reserved warn-to-grant gate ──────
    await page.getByRole('button', { name: /New role/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Role name').fill(ROLE_NAME);

    // A reserved permission is disabled until the explicit acknowledgement.
    const walletAdjust = dialog.locator('label', { hasText: 'wallet:adjust' }).getByRole('checkbox');
    await expect(walletAdjust).toBeDisabled();

    await dialog.getByText(/Allow granting reserved/i).click();
    await expect(
      dialog.getByText(/Reserved permissions let staff perform sensitive actions/i),
    ).toBeVisible();
    await expect(walletAdjust).toBeEnabled();

    // Grant a reserved perm (proves the allowReserved Lock-1 path) + a benign read.
    await walletAdjust.check();
    await dialog.locator('label', { hasText: 'kyc:read' }).getByRole('checkbox').check();

    await dialog.getByRole('button', { name: /Create role/i }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(ROLE_NAME)).toBeVisible();

    // ── STAFF PANEL: page renders; add a staff assigned the new role ────────────
    await page.goto('/gifsy/staff');
    await expect(page.getByRole('heading', { name: 'Gifsy Staff' })).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /Add staff/i }).first().click();
    const staffDialog = page.getByRole('dialog');
    await expect(staffDialog).toBeVisible();
    await staffDialog.getByLabel('Full name').fill(STAFF_NAME);
    await staffDialog.getByLabel('Phone').fill(STAFF_PHONE);
    await staffDialog.getByLabel('Role').selectOption({ label: ROLE_NAME });
    await staffDialog.getByRole('button', { name: 'Add staff' }).click();
    await expect(staffDialog).toBeHidden();

    // The new staff appears, and its row shows the assigned role name.
    await expect(page.getByText(STAFF_NAME)).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(STAFF_NAME) })).toContainText(ROLE_NAME);

    // ── CLEANUP (authenticated API via the shared session cookies) ──────────────
    const staff = (await (await page.request.get('/api/gifsy/staff')).json()).data.find(
      (s: { id: string; name: string }) => s.name === STAFF_NAME,
    );
    if (staff) expect((await page.request.delete(`/api/admin/users/${staff.id}`)).ok()).toBeTruthy();

    const role = (await (await page.request.get('/api/gifsy/roles')).json()).data.find(
      (r: { id: string; name: string }) => r.name === ROLE_NAME,
    );
    if (role) expect((await page.request.delete(`/api/gifsy/roles/${role.id}`)).ok()).toBeTruthy();
  });
});
