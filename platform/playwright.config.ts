import { defineConfig, devices } from '@playwright/test';
import { ROLES, type RoleDef } from './e2e/fixtures/roles';
import { resolveEnv } from './e2e/fixtures/env';

// hostHeader (local prod-build) strategy: each role project injects `x-forwarded-host: <role.host>` on
// every spec request so the FE proxy resolves the tenant from the host — the same way staging does by
// real subdomain — since the local run is now a production build (`next start`), not `next dev`. Inert
// for staging/subdomain (real Host is authoritative) and for devClientIdField. Setup is multi-role, so
// IT sets the header per-role inside login() instead of here. See e2e/fixtures/env.ts TenantStrategy.
const ENV = resolveEnv();
function tenantHeaders(role: RoleDef): Record<string, string> | undefined {
  return ENV.tenantStrategy === 'hostHeader' && role.host
    ? { 'x-forwarded-host': role.host }
    : undefined;
}

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
  // Reset gifsy_dev to a pristine seed baseline before the suite (LOCAL only; skipped for staging and
  // when E2E_SKIP_RESET is set) — makes every run reproducible. See e2e/global-setup.ts.
  globalSetup: './e2e/global-setup.ts',
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
      use: { ...devices['Desktop Chrome'], storageState: ROLES.partner.storageStatePath, extraHTTPHeaders: tenantHeaders(ROLES.partner) },
    },
    {
      name: 'clientAdmin',
      testMatch: /clientAdmin\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.clientAdmin.storageStatePath, extraHTTPHeaders: tenantHeaders(ROLES.clientAdmin) },
    },
    {
      name: 'sales',
      testMatch: /sales\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.sales.storageStatePath, extraHTTPHeaders: tenantHeaders(ROLES.sales) },
    },
    {
      name: 'gifsy',
      testMatch: /gifsy\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.gifsy.storageStatePath, extraHTTPHeaders: tenantHeaders(ROLES.gifsy) },
    },
    {
      name: 'clientbAdmin',
      testMatch: /clientbAdmin\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.clientbAdmin.storageStatePath, extraHTTPHeaders: tenantHeaders(ROLES.clientbAdmin) },
    },
    {
      // CP004 (seed-cp-4) — an APPROVED, funded deoleo partner. Hosts the money-path redeem specs that
      // require KYC-APPROVED (the default `partner`/CP001 is the pending-KYC fixture and 400s on confirm).
      name: 'partnerApproved',
      testMatch: /partnerApproved\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.partnerApproved.storageStatePath, extraHTTPHeaders: tenantHeaders(ROLES.partnerApproved) },
    },
    {
      name: 'mis',
      testMatch: /mis\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.mis.storageStatePath, extraHTTPHeaders: tenantHeaders(ROLES.mis) },
    },
    {
      name: 'salesManager',
      testMatch: /salesManager\/.*\.e2e\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: ROLES.salesManager.storageStatePath, extraHTTPHeaders: tenantHeaders(ROLES.salesManager) },
    },
  ],
});
