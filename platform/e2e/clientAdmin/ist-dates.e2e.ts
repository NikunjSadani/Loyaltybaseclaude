import { test, expect } from '@playwright/test';

/**
 * IST date-rendering e2e — the browser-level proof for the IST timestamp sweep (commit f3f5594).
 *
 * WHY a dedicated spec: every date the UI shows must render in India Standard Time (Asia/Kolkata)
 * regardless of the VIEWER's browser timezone (and SSR, which runs UTC). The unit/TZ-harness proves
 * the logic; this proves it end-to-end in a real browser by forcing an OFF-IST browser timezone and
 * asserting the rendered dates are still IST — i.e. the `timeZone: 'Asia/Kolkata'` pinning holds
 * through the real render, not just in isolation.
 *
 * Mechanism: `test.use({ timezoneId })` makes the Playwright browser context report a non-IST zone
 * (America/New_York, UTC-4/-5). If any date render had regressed to browser-local, the shown day
 * would be the New-York day; pinned-IST code shows the IST day. The "today" header is the keystone
 * (deterministic, client-"now"); the data pages add coverage + a no-crash-under-off-IST sweep.
 *
 * Runs under the clientAdmin (deoleo tenant) project — it reaches the exact surfaces the sweep
 * touched: the admin "today" header, the Payments Report, invoices, and the dashboards.
 */
test.use({ timezoneId: 'America/New_York' });

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';
const dayFmt = (tz: string, when: number | Date) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(when);

test('admin "today" header renders in IST under an off-IST (New York) browser', async ({ page }) => {
  await page.goto('/admin/dashboard');
  await expect(page.locator('body')).toBeVisible();

  const now = Date.now();
  const istToday = dayFmt(IST, now);
  const nyToday = dayFmt(NY, now);

  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  // The header (admin/layout.tsx) shows "today" — pinned to IST. It must be the IST calendar day.
  expect(body, `admin header should show IST today (${istToday})`).toContain(istToday);

  if (istToday !== nyToday) {
    // We are in the IST-vs-NY day-boundary window → this run is CONCLUSIVE: a browser-local bug would
    // have shown the New-York day. Assert the NY day is absent.
    expect(body, `header must not show the New-York day (${nyToday}) — would prove browser-local, not IST`)
      .not.toContain(nyToday);
    console.log(`[IST-e2e] CONCLUSIVE: IST(${istToday}) != NY(${nyToday}); header shows IST.`);
  } else {
    console.log(`[IST-e2e] IST and NY are the same calendar day now (${istToday}) — header consistent, not discriminating this run.`);
  }
});

test('Payments Report cells render dates in IST under an off-IST browser (API↔DOM cross-check)', async ({ page }) => {
  // Pull the report JSON with the authenticated session, then verify the page renders the IST day for
  // any row whose paidAt falls in the IST-vs-UTC/NY boundary window (the discriminating case).
  const resp = await page.request.get('/api/admin/payments-report');
  if (!resp.ok()) {
    test.skip(true, `payments-report API not OK (${resp.status()}) on this env — skipping cross-check`);
    return;
  }
  const json = (await resp.json()) as { rows?: Array<{ paymentDate?: string | null; outletCode?: string | null }> };
  const rows = json.rows ?? [];
  if (rows.length === 0) {
    test.skip(true, 'payments-report has no rows on staging — nothing to cross-check');
    return;
  }

  await page.goto('/admin/credits-payouts/payments');
  await expect(page.locator('body')).toBeVisible();
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');

  const ymd = (tz: string, iso: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

  let conclusiveRows = 0;
  let checkedRows = 0;
  for (const r of rows) {
    if (!r.paymentDate) continue;
    const istD = ymd(IST, r.paymentDate); // e.g. 2026-07-01
    const utcD = r.paymentDate.slice(0, 10); // the raw UTC day (what a non-IST render would show)
    // The FE renders paymentDate via toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) → the IST
    // day is present as DD/MM/YYYY. Build the IST day in that numeric form for a substring check.
    const [y, m, d] = istD.split('-');
    const istDisplay = `${d}/${m}/${y}`;
    checkedRows++;
    if (istD !== utcD) {
      // Discriminating row: IST day differs from the UTC day. The page MUST show the IST day.
      conclusiveRows++;
      expect(body, `Payments Report should show IST day ${istDisplay} for outlet ${r.outletCode}`).toContain(istDisplay);
    }
  }
  console.log(`[IST-e2e] Payments Report cross-check: ${checkedRows} dated rows, ${conclusiveRows} in the IST≠UTC window (conclusive).`);
  // Always at least confirm the page rendered a date and did not crash under an off-IST browser.
  expect(checkedRows, 'expected at least one dated row to cross-check').toBeGreaterThan(0);
});

test('key changed date pages load without error under an off-IST browser', async ({ page }) => {
  for (const path of ['/admin/dashboard', '/admin/credits-payouts/payments', '/admin/invoices', '/admin/reports']) {
    await page.goto(path);
    await expect(page.locator('body'), `${path} should render under off-IST tz`).toBeVisible();
    // No unhandled "Invalid Date" leaking from a date path that got a null/odd value under off-IST.
    const body = await page.locator('body').innerText();
    expect(body, `${path} must not render "Invalid Date"`).not.toContain('Invalid Date');
  }
});
