// Capture real payout-screen screenshots for the Payouts guide.
//
// Re-runnable: drives the deployed STAGING operator console with a real login
// (fixed OTP), assumes the Deoleo brand, and screenshots each payout screen to
// platform/public/guides/payouts/<name>.png. Because it's a script (not a doc of
// stale images), the guide's screenshots can be refreshed any time the UI changes:
//
//   node scripts/capture-payout-screens.mjs
//
// Env (all have sane staging defaults):
//   BASE_URL   default https://uat.app.gifsy.in
//   OP_PHONE   default 9830011252  (the Gifsy operator)
//   OTP        default 123456      (staging fixed OTP)
//   BRAND      default deoleo      (brand to "Work in brand" into, for sample data)
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const BASE_URL = process.env.BASE_URL ?? 'https://uat.app.gifsy.in';
const OP_PHONE = process.env.OP_PHONE ?? '9830011252';
const OTP = process.env.OTP ?? '123456';
const BRAND = process.env.BRAND ?? 'deoleo';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'public', 'guides', 'payouts');

/** The screens to capture, in guide order. name = output file stem. */
const SCREENS = [
  { name: 'credits-payouts-hub', url: '/admin/credits-payouts', wait: /credits|payout/i },
  { name: 'upload', url: '/admin/credits-payouts/upload', wait: /upload|template/i },
  { name: 'payout-download', url: '/admin/credits-payouts/payout', wait: /generate|download|utr/i },
  { name: 'payout-status', url: '/admin/credits-payouts/status', wait: /status|paid|pending/i },
  { name: 'fields', url: '/admin/credits-payouts/fields', wait: /field/i },
  { name: 'redemption-payouts', url: '/admin/payouts', wait: /payout|batch|transaction/i },
  { name: 'outlet-wallet', url: '/admin/outlet-wallet', wait: /wallet|outlet/i },
  { name: 'tds', url: '/admin/tds', wait: /tds|194/i },
  { name: 'invoices', url: '/admin/invoices', wait: /invoice/i },
  { name: 'gst-reimbursements', url: '/admin/gst-reimbursements', wait: /gst|reimburse/i },
];

async function login(page) {
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  const phone = page.locator('input[type="tel"]');
  const otpBoxes = page.locator('input[inputmode="numeric"][maxlength="1"]');
  await phone.waitFor({ state: 'visible', timeout: 20_000 });

  // Send OTP, retried past the hydration race until the OTP step renders.
  await expectToPass(async () => {
    if (await otpBoxes.first().isVisible().catch(() => false)) return;
    await phone.fill(OP_PHONE);
    await page.getByRole('button', { name: 'Send OTP' }).click();
    await otpBoxes.first().waitFor({ state: 'visible', timeout: 5_000 });
  });

  // Type the 6-digit code as real keystrokes (the boxes auto-advance).
  await expectToPass(async () => {
    for (let i = 0; i < 6; i++) await otpBoxes.nth(i).fill('');
    await otpBoxes.first().click();
    await page.keyboard.type(OTP, { delay: 40 });
    for (let i = 0; i < 6; i++) {
      const v = await otpBoxes.nth(i).inputValue();
      if (v !== OTP[i]) throw new Error(`otp box ${i} = "${v}"`);
    }
  });

  await page.waitForURL((u) => !u.pathname.startsWith('/auth/login'), { timeout: 20_000 });
}

async function assumeBrand(page) {
  await page.goto(`${BASE_URL}/gifsy`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /work in brand/i }).click();
  const brand = page.getByRole('button', { name: new RegExp(BRAND, 'i') }).first();
  await brand.waitFor({ state: 'visible', timeout: 10_000 });
  await brand.click();
  await page.waitForURL(/\/admin\//, { timeout: 20_000 });
}

async function capture(page, screen) {
  try {
    await page.goto(`${BASE_URL}${screen.url}`, { waitUntil: 'domcontentloaded' });
    // best-effort settle: let data load and any client fetch finish
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const out = path.join(OUT_DIR, `${screen.name}.png`);
    await page.screenshot({ path: out, fullPage: true });
    console.log(`  ✓ ${screen.name}  →  ${path.relative(process.cwd(), out)}`);
  } catch (e) {
    console.warn(`  ✗ ${screen.name}  (${screen.url}): ${e.message}`);
  }
}

async function expectToPass(fn, { timeout = 30_000, interval = 500 } = {}) {
  const start = Date.now();
  let last;
  for (;;) {
    try {
      await fn();
      return;
    } catch (e) {
      last = e;
      if (Date.now() - start > timeout) throw last;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    console.log(`Logging in as ${OP_PHONE} on ${BASE_URL} …`);
    await login(page);
    console.log(`Assuming brand "${BRAND}" …`);
    await assumeBrand(page);
    console.log(`Capturing ${SCREENS.length} screens →  ${path.relative(process.cwd(), OUT_DIR)}`);
    for (const s of SCREENS) await capture(page, s);
  } finally {
    await browser.close();
  }
  console.log('Done.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
