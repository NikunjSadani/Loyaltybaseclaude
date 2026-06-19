import { defineConfig, devices } from '@playwright/test';
import { ROLES } from './e2e/fixtures/roles';

/**
 * Go-live E2E harness — the executable form of `docs/plans/DATA-VISIBILITY.md`.
 * See `docs/plans/GO-LIVE-READINESS.md` for the intent: a green LOCAL run must mean
 * we can push `develop` expecting staging → prod to pass (no half-baked merges).
 *
 * Env-parameterised (so the SAME suite is the local merge gate AND the staging pre-prod gate):
 *   E2E_BASE_URL  — default http://localhost:3000 (local). Set to the staging FE URL for the pre-prod run.
 *   E2E_OTP       — default 123456 (local FIXED_OTP).
 *
 * ⚠️ STAGING SUPPORT IS NOT YET COMPLETE. The env knobs exist, but a staging run additionally needs
 *    (a) a real-MSG91 OTP-injection strategy (FIXED_OTP is local-only) and (b) staging tenant slugs
 *    in fixtures/roles.ts (the seeded `deoleo`/`gifsy` clientIds may differ on staging). Until both
 *    land, this harness is the LOCAL merge gate only; the staging pre-prod gate is a TODO.
 *
 * Naming: tests are `*.e2e.ts` (vitest is configured to ignore `e2e/**`, so `npm test` won't touch them).
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // Each spec drives the real running stack (FE → proxy → backend → gifsy_dev). No app is spawned here:
  // the owner already runs `next dev` (:3000) + `node dist/main.js` (:4000) + the DB proxy (:5433).
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    // 1. Log in each role through the REAL login form, persist its storageState.
    { name: 'setup', testMatch: /setup\/auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },

    // 2. Login matrix — fresh context (NO storageState): exercises the real login per role and
    //    asserts which roles work vs the known-broken one (#39 GIFSY). Independent of setup.
    { name: 'login', testMatch: /login\/.*\.e2e\.ts/, use: { ...devices['Desktop Chrome'] } },

    // 3. Role projects reuse the persisted session.
    {
      name: 'partner',
      testMatch: /partner\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.partner.storageStatePath },
    },
    {
      name: 'clientAdmin',
      testMatch: /clientAdmin\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.clientAdmin.storageStatePath },
    },
    {
      name: 'sales',
      testMatch: /sales\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.sales.storageStatePath },
    },
  ],
});
