import { expect, type Page } from '@playwright/test';
import { FABRICATED_TOKENS } from '../fixtures/fabricated';

/**
 * Assert the page renders NO known fabricated/demo value (gap #40). Reads the full rendered text
 * once and checks every applicable token, so a single failure lists exactly which leftover surfaced.
 *
 * ⚠️ KNOWN LIMIT (S5): this scans `innerText` only — it does NOT see values rendered into input
 * `value`/`placeholder`, `aria-label`/`alt`/`title` attributes, `<title>`/`<meta>`, or SVG/canvas.
 * A page that hides a fake number in `<input value="2947">` would slip past. Add attribute/value
 * assertions per-page when a flow renders data into form controls.
 */
export async function expectNoFabricatedData(page: Page): Promise<void> {
  await expect(page.locator('body')).toBeVisible();
  const pathname = new URL(page.url()).pathname;
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  for (const token of FABRICATED_TOKENS) {
    // S3: a token scoped to specific paths only fails on those paths (avoids false reds at scale
    // when a legitimate real value on one page collides with a demo token from another).
    if (token.onlyOnPaths && !token.onlyOnPaths.some((p) => pathname.startsWith(p))) continue;
    expect(
      body.includes(token.text),
      `Fabricated value "${token.text}" found on ${page.url()} — ${token.note}`,
    ).toBe(false);
  }
}

/**
 * Assert a role is correctly scoped OUT of a page it must not reach: either the FE redirects it to a
 * KNOWN-SAFE destination, or the page renders an explicit forbidden state — never another scope's
 * real data (gap #41 / Q6 cross-tenant).
 *
 * Hardened against false passes:
 *  - FP-2: requires a LIVE session first (a dead/expired session would bounce everything to login and
 *    pass this vacuously); and a redirect only counts if it lands on `safeRedirects` (default
 *    `/auth/login`) — never "redirected to anywhere".
 *  - FP-3: the in-place "blocked" signal is an EXPLICIT authz phrase only (no incidental "no data"),
 *    and `forbiddenMarkers` (real strings that prove a leak) should be supplied for data-bearing pages.
 */
export async function expectScopedOut(
  page: Page,
  path: string,
  opts: { forbiddenMarkers?: string[]; safeRedirects?: string[] } = {},
): Promise<void> {
  await page.goto(path);
  // The FE route guard runs client-side (post-hydration), so a correct scope-out redirect fires a
  // beat AFTER goto resolves. Give it up to 5s to settle before judging; if no redirect, fall through
  // to the in-place forbidden/leak checks.
  await page.waitForURL((u) => !u.pathname.startsWith(path), { timeout: 5_000 }).catch(() => {});
  await expect(page.locator('body')).toBeVisible();
  const url = new URL(page.url());

  // Live-session guard (FP-2), read AFTER navigating so we're on the http origin (reading
  // localStorage on about:blank throws SecurityError). The FE redirects to /auth/login only when no
  // token exists, so a dead/expired session lands here with no token → this fails LOUDLY rather than
  // letting a login-redirect masquerade as "correctly scoped out".
  const token = await page.evaluate(() => localStorage.getItem('token'));
  expect(token, `no live session when testing scope-out of ${path} (dead/expired session, not an authz block?)`).toBeTruthy();

  if (!url.pathname.startsWith(path)) {
    // Redirected — only acceptable if it landed on a known-safe destination.
    const safe = opts.safeRedirects ?? ['/auth/login'];
    expect(
      safe.some((s) => url.pathname.startsWith(s)),
      `${path} redirected to ${url.pathname}, not a known-safe destination (${safe.join(', ')})`,
    ).toBe(true);
    return;
  }

  // Rendered in place → must leak none of the markers AND show an explicit forbidden state.
  const body = (await page.locator('body').innerText()).toLowerCase();
  for (const marker of opts.forbiddenMarkers ?? []) {
    expect(
      body.includes(marker.toLowerCase()),
      `Scope leak: "${marker}" visible to a role that must not see ${path}`,
    ).toBe(false);
  }
  const looksBlocked = /(forbidden|not authori|access denied|don'?t have permission|\b403\b)/.test(body);
  expect(
    looksBlocked,
    `Expected ${path} to redirect or show an EXPLICIT forbidden state for this role, but it rendered content`,
  ).toBe(true);
}
