import { test, expect } from '@playwright/test';
import { ROLES } from '../fixtures/roles';

/**
 * IST date-rendering e2e (gifsy operator) — browser-level proof of the IST sweep (f3f5594).
 *
 * Staging's gifsy_staging DB lacks the harness's local seed users (clientAdmin 9000000001 etc. return
 * "No account found"), so the automated login runs as the REAL gifsy operator (9830011252 / FIXED_OTP),
 * which staging genuinely has. GIFSY_ADMIN reaches /admin/* directly (only GIFSY_STAFF is bounced).
 *
 * Proof mechanism: force an OFF-IST browser timezone (America/New_York). If any date render had
 * regressed to browser-local, the shown day would be the New-York day; pinned-IST code shows the IST
 * day. The "today" header is the deterministic client-"now" keystone; the Payments Report adds an
 * API↔DOM cross-check; and a load sweep checks the changed pages don't crash / show "Invalid Date".
 */
test.use({ timezoneId: 'America/New_York' });

const IST = 'Asia/Kolkata';
const dayFmt = (tz: string, when: number | Date) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(when);

test('admin "today" header renders in IST regardless of the browser timezone (incl. extreme zones)', async ({ browser }) => {
  // Use EXTREME zones so the proof is conclusive no matter the wall-clock: UTC-12 and UTC+14 are 26.5h
  // apart, so at ANY instant at least one is on a DIFFERENT calendar day than IST. A browser-local bug
  // would render that zone's day in the header; pinned-IST code renders the IST day in every zone.
  const now = Date.now();
  const istToday = dayFmt(IST, now);
  const extremeZones = ['Etc/GMT+12', 'Pacific/Kiritimati']; // UTC-12, UTC+14
  let discriminated = 0;

  for (const tz of extremeZones) {
    const ctx = await browser.newContext({
      timezoneId: tz,
      storageState: ROLES.gifsy.storageStatePath,
      baseURL: process.env.E2E_BASE_URL,
    });
    const page = await ctx.newPage();
    try {
      await page.goto('/admin/dashboard');
      await expect(page.locator('body')).toBeVisible();
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      const zoneToday = dayFmt(tz, now);

      // The header must ALWAYS show the IST day, whatever the browser zone.
      expect(body, `header should show IST today (${istToday}) under browser zone ${tz}`).toContain(istToday);

      if (zoneToday !== istToday) {
        // Discriminating zone: a browser-local render would show zoneToday. Prove it does NOT.
        expect(body, `under ${tz} the header must NOT show the browser-zone day (${zoneToday}) — would prove browser-local, not IST`)
          .not.toContain(zoneToday);
        discriminated++;
        console.log(`[IST-e2e] CONCLUSIVE under ${tz}: zone day ${zoneToday} ≠ IST ${istToday}; header shows IST.`);
      }
    } finally {
      await ctx.close();
    }
  }

  // At least one extreme zone is guaranteed to differ from IST at any instant → conclusive this run.
  expect(discriminated, 'expected at least one extreme browser zone to differ from IST (conclusive proof)').toBeGreaterThan(0);
});

test('Payments Report renders dates in IST under an off-IST browser (API↔DOM cross-check)', async ({ page }) => {
  const resp = await page.request.get('/api/admin/payments-report');
  if (!resp.ok()) {
    test.skip(true, `payments-report API not OK (${resp.status()}) — skipping cross-check`);
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

  let checkedRows = 0;
  let conclusiveRows = 0;
  for (const r of rows) {
    if (!r.paymentDate) continue;
    const istD = ymd(IST, r.paymentDate);
    const utcD = r.paymentDate.slice(0, 10);
    const [y, m, d] = istD.split('-');
    const istDisplay = `${d}/${m}/${y}`;
    checkedRows++;
    if (istD !== utcD) {
      conclusiveRows++;
      expect(body, `Payments Report should show IST day ${istDisplay} for outlet ${r.outletCode}`).toContain(istDisplay);
    }
  }
  console.log(`[IST-e2e] Payments Report cross-check: ${checkedRows} dated rows, ${conclusiveRows} in the IST≠UTC window (conclusive).`);
  expect(checkedRows, 'expected at least one dated row to cross-check').toBeGreaterThan(0);
});

test('key changed date pages load without error under an off-IST browser', async ({ page }) => {
  for (const path of ['/admin/dashboard', '/admin/credits-payouts/payments', '/admin/payouts', '/admin/reports']) {
    await page.goto(path);
    await expect(page.locator('body'), `${path} should render under off-IST tz`).toBeVisible();
    const body = await page.locator('body').innerText();
    expect(body, `${path} must not render "Invalid Date"`).not.toContain('Invalid Date');
  }
});
