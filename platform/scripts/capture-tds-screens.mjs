// Capture TDS-guide screenshots from staging (re-runnable). Writes to public/guides/tds/*.png.
//   node scripts/capture-tds-screens.mjs
// Guard: staging only (screenshots must contain test data, never real prod PAN/bank).
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const BASE_URL = process.env.BASE_URL ?? 'https://uat.app.gifsy.in';
const OP_PHONE = process.env.OP_PHONE ?? '9830011252';
const OTP = process.env.OTP ?? '123456';
const BRAND = process.env.BRAND ?? 'deoleo';
if (!/uat\.app\.gifsy\.in/i.test(BASE_URL) && process.env.ALLOW_NONSTAGING !== '1') {
  console.error(`Refusing to capture from ${BASE_URL}: staging test data only.`); process.exit(1);
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'public', 'guides', 'tds');

async function login(page) {
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  const phone = page.locator('input[type="tel"]');
  const otp = page.locator('input[inputmode="numeric"][maxlength="1"]');
  await phone.waitFor({ state: 'visible', timeout: 25000 });
  for (let t = 0; t < 8; t++) { if (await otp.first().isVisible().catch(() => false)) break; await phone.fill(OP_PHONE); await page.getByRole('button', { name: 'Send OTP' }).click(); await otp.first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {}); }
  for (let i = 0; i < 6; i++) await otp.nth(i).fill('');
  await otp.first().click(); await page.keyboard.type(OTP, { delay: 60 });
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/login'), { timeout: 25000 });
}
async function shot(page, url, name, waitText) {
  await page.goto(`${BASE_URL}${url}`, { waitUntil: 'domcontentloaded' });
  if (waitText) await page.getByText(waitText, { exact: false }).first().waitFor({ timeout: 12000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log(`  ✓ ${name}`);
}
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
  try {
    await login(page);
    // Statutory editor lives in the platform (un-assumed) Gifsy shell
    await shot(page, '/gifsy/tds-statutory', 'tds-statutory', 'TDS Statutory');
    // 194R report lives in the assumed-brand admin shell
    await page.goto(`${BASE_URL}/gifsy`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /work in brand/i }).click();
    await page.getByRole('button', { name: new RegExp(BRAND, 'i') }).first().click();
    await page.waitForURL(/\/admin\//, { timeout: 20000 });
    await shot(page, '/admin/tds', '194r-report', 'TDS');
  } finally { await browser.close(); }
  console.log('Done.');
})().catch((e) => { console.error(e); process.exit(1); });
