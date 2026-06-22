import { defineConfig, devices } from '@playwright/test';
import { ROLES } from './e2e/fixtures/roles';
import { resolveEnv } from './e2e/fixtures/env';

/**
 * Go-live E2E harness — the executable form of `docs/plans/DATA-VISIBILITY.md`.
 * See `docs/plans/GO-LIVE-READINESS.md` for the intent: a green LOCAL run must mean
 * we can push `develop` expecting staging → prod to pass (no half-baked merges).
 *
 * Env-parameterised (so the SAME suite is the local merge gate AND the staging pre-prod gate). All
 * env resolution lives in `e2e/fixtures/env.ts`; the knobs:
 *   E2E_ENV            — local | staging (default local). Selects per-env defaults below.
 *   E2E_BASE_URL       — FE URL. Local default http://localhost:3000; REQUIRED for staging (no default).
 *   E2E_OTP            — the fixed OTP (default 123456 = local FIXED_OTP).
 *   E2E_OTP_STRATEGY   — fixed | fetch. Default fixed (local). Staging defaults to fetch (real MSG91);
 *                        set fixed if the staging backend itself runs with FIXED_OTP.
 *   E2E_OTP_FETCH_URL  — (fetch only) test-only endpoint returning the just-sent OTP; see e2e/README.md.
 *   E2E_OTP_FETCH_TOKEN— (fetch only) shared secret guarding that endpoint.
 *   E2E_TENANT_STRATEGY— devClientIdField | subdomain. Local types the dev org field; staging uses host.
 *
 * BACKWARD-COMPATIBLE: with no env vars set this is exactly the prior local behavior.
 *
 * Naming: tests are `*.e2e.ts` (vitest is configured to ignore `e2e/**`, so `npm test` won't touch them).
 */
const BASE_URL = resolveEnv().baseURL;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // Each spec drives the real running stack (FE → proxy → backend → gifsy_dev). No app is spawned here:
  // the owner already runs `next dev` (:3000) + `node dist/main.js` (:4000) + the DB proxy (:5433).
  // ⚠️ Runtime is SERIAL by design (single worker). Specs share live DB state — the partner
  // redemption + sales-assisted-redemption flows both DRAIN points from the same seeded outlet, so
  // concurrent execution would make them flake/double-spend. The "parallel waves of disjoint files"
  // in E2E-COVERAGE-PLAN.md §3 are about parallel AUTHORING (many agents writing different files at
  // once), NOT parallel RUNTIME. Do not raise `workers` without first making the write specs
  // state-independent (unique fixtures per run).
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // 1 retry locally too: `next dev` compiles a route on its first hit, which can exceed the 10s
  // expect timeout on a cold route and flake a `toBeVisible` (the page renders fine on retry, once
  // the route is warm). A single retry absorbs that dev-server-only first-compile latency.
  retries: 1,
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

    // 2. Role projects reuse the persisted session.
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
    {
      name: 'gifsy',
      testMatch: /gifsy\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.gifsy.storageStatePath },
    },
    {
      name: 'clientbAdmin',
      testMatch: /clientbAdmin\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.clientbAdmin.storageStatePath },
    },
    {
      name: 'mis',
      testMatch: /mis\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.mis.storageStatePath },
    },
    {
      name: 'salesManager',
      testMatch: /salesManager\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.salesManager.storageStatePath },
    },
  ],
});
