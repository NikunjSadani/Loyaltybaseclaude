import { test, expect } from '@playwright/test';

/**
 * UAT regression — Employee Hierarchy template round-trip (§10).
 *
 * Reported bug: "downloaded the template and uploaded the same — it says 'not a valid .xlsx'".
 * Root cause: the page read the FileReader ArrayBuffer with `XLSX.read(data, {type:'array'})`, but
 * SheetJS's `type:'array'` expects a Uint8Array. The Node build tolerates an ArrayBuffer (so unit
 * tests passed) but the BROWSER build cannot read `.length` off it and threw — surfaced as the
 * misleading "not a valid .xlsx" on a perfectly valid template. This test drives the real browser
 * bundle, so it catches the browser-only regression the Node round-trip could not.
 */
test.describe('@clientAdmin hierarchy template round-trip', () => {
  test('download template → re-upload the SAME file → accepted (not rejected as invalid xlsx)', async ({ page }) => {
    await page.goto('/admin/hierarchy');
    await expect(page.locator('[data-testid="download-template"]')).toBeVisible({ timeout: 15_000 });

    // 1) Download the template the UI generates in-browser.
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="download-template"]').click();
    const download = await downloadPromise;
    const filePath = await download.path();
    expect(filePath, 'template downloaded to a real path').toBeTruthy();

    // 2) Re-upload the exact downloaded file (hidden input; setInputFiles works on hidden inputs).
    await page.locator('[data-testid="hierarchy-upload-input"]').setInputFiles(filePath!);

    // 3) NEGATIVE: the bug's error text must NOT appear for a valid template.
    await expect(page.getByText(/Could not read the file/i)).toHaveCount(0);
    await expect(page.getByText(/valid Excel \(\.xlsx\) file/i)).toHaveCount(0);

    // 4) POSITIVE: the file was actually read + parsed → the validation panel renders. (Without this
    //    the negative assertion could pass vacuously if the upload silently no-op'd.)
    await expect(page.locator('[data-testid="validation-panel"]')).toBeVisible({ timeout: 15_000 });
  });

  /**
   * Persistence round-trip — the test that would have caught "shows N then 0 after refresh".
   *
   * Root cause was server-side: persistHierarchy's SalesHierarchyLevel.upsert re-assigned each code
   * to its config `level`, colliding with the SECOND unique (clientId, level) when the tenant already
   * had a different code→level arrangement → P2002 → the whole $transaction rolled back → the
   * ProgramSetting snapshot was never written → a reload read nothing → 0. The FE then HID the 500
   * with a fire-and-forget PUT + swallowed .catch, so the success banner showed regardless.
   *
   * This test confirms the upload, asserts a real success indicator (NOT an error), then RELOADS and
   * asserts the uploaded employee is STILL rendered — proving the write actually persisted.
   */
  test('upload → confirm → SUCCESS (no error) → reload → employees STILL persist (not 0)', async ({ page }) => {
    await page.goto('/admin/hierarchy');
    await expect(page.locator('[data-testid="download-template"]')).toBeVisible({ timeout: 15_000 });

    // 1) Download the in-browser template and re-upload it verbatim — a valid chain set.
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="download-template"]').click();
    const download = await downloadPromise;
    const filePath = await download.path();
    expect(filePath, 'template downloaded to a real path').toBeTruthy();
    await page.locator('[data-testid="hierarchy-upload-input"]').setInputFiles(filePath!);

    // 2) The validation panel must reach the "ready to confirm" state (clean chain → Confirm button).
    await expect(page.locator('[data-testid="validation-panel"]')).toBeVisible({ timeout: 15_000 });
    const confirmBtn = page.locator('[data-testid="confirm-upload-btn"]');
    await expect(confirmBtn).toBeVisible({ timeout: 10_000 });

    // 3) Confirm the upload — this drives persistEmployees → PUT /api/admin/hierarchy-config.
    await confirmBtn.click();

    // 4) SUCCESS, not error. Race the two TERMINAL banners so a rejected confirm fails FAST with the
    //    server's actual message instead of a blind 15s timeout on a success banner that will never
    //    appear. If the failure banner is the one that renders, surface its exact text — this keeps the
    //    guard STRICT (a real persistence failure still fails the test) while making the cause obvious.
    //
    //    PRECONDITION: this test presumes a genuinely clean gifsy_dev (`prisma migrate reset` + seed).
    //    The confirm PUT is CORRECTLY rejected by the backend §0b phone-uniqueness guard if any template
    //    example phone (the RSM example row emits phone 9900000004) already belongs to a DIFFERENT
    //    employee code left over in the tenant. The seed is upsert-only (it never wipes prior sales
    //    users), so an upsert-on-a-dirty-DB reseed can leave an orphan (e.g. `RSM-EX5` still holding
    //    9900000004 from an older template revision) that trips the guard. That is an environment/data
    //    residue problem, not a UI regression — do NOT relax this assertion to paper over it.
    const successBanner = page.getByText(/Upload confirmed:/i);
    const failureBanner = page.getByText(/Upload could not be saved/i);
    await expect(successBanner.or(failureBanner)).toBeVisible({ timeout: 15_000 });
    if (await failureBanner.isVisible()) {
      throw new Error(
        `Confirm upload was rejected by the server (expected success): ${await failureBanner.textContent()}`,
      );
    }
    await expect(successBanner).toBeVisible();

    // 5) PERSISTENCE: reload (forces a fresh backend GET, not optimistic state) and assert the
    //    template's leaf employee code is STILL rendered. This is the "0 after refresh" guard.
    //    The current chain template (getHierarchyChainTemplateData) emits the leaf row as
    //    `${leafRoleCode}-P001`; for the deoleo hierarchy the leaf role is XSR → "XSR-P001".
    await page.reload();
    await expect(page.locator('.animate-spin').or(page.locator('[aria-label="Loading"]'))).toHaveCount(0, {
      timeout: 12_000,
    });
    await expect(page.getByText('XSR-P001').first()).toBeVisible({ timeout: 12_000 });
  });
});
