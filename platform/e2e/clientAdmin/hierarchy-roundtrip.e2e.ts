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
});
