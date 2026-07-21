/**
 * E2E environment resolution — the ONE place that knows how local and staging differ.
 *
 * The same specs run against LOCAL dev (the merge gate) and STAGING (the pre-prod gate). The three
 * things that differ between them are isolated here so the specs/fixtures stay env-agnostic:
 *   1. base URL          — where the FE is served.
 *   2. tenant strategy    — how a role's tenant is identified (local dev clientId override field vs
 *                           staging host/subdomain). See ENVIRONMENTS.md "resolveClientId(host)".
 *   3. OTP source         — local FIXED_OTP (a known constant) vs staging real-MSG91 (must be fetched).
 *
 * 100% BACKWARD-COMPATIBLE: with NO new env vars set, this resolves to the exact local behavior the
 * harness had before (base URL http://localhost:3000, fixed OTP 123456, dev clientId override field).
 *
 * Selection:
 *   E2E_ENV=local|staging   — high-level switch (default: local). Sets sane defaults for the env.
 *   Individual vars below    — override any single dimension regardless of E2E_ENV.
 */

export type E2eEnvName = 'local' | 'staging';

/** How a role's tenant is told to the backend. */
export type TenantStrategy =
  /**
   * Local PROD-BUILD (the default): inject `x-forwarded-host: <role.host>` on every request so the
   * FE proxy + login server action resolve the tenant from the host — EXACTLY as staging does by real
   * subdomain. This is the local strategy since AF-6/Turbopack: the harness now runs against a local
   * production build (`next build` + `next start`), NOT `next dev` — because (a) Turbopack `next dev`
   * does not run the proxy for `/api/*` (client-side calls 401), and (b) the dev "Organization" field
   * (below) is compiled OUT of a production build (`process.env.NODE_ENV` is inlined at build). The
   * header is TRUSTED locally because `EDGE_SECRET` is unset (see lib/platform/edge-trust.ts); on a real
   * deploy EDGE_SECRET is set so an unsigned x-forwarded-host is ignored — this affordance is inert there.
   */
  | 'hostHeader'
  /** Legacy local `next dev`: type the clientId into the dev-only "Organization" override field. Kept for
   *  back-compat, but `next dev` no longer runs the proxy for `/api/*` — prefer `hostHeader` + a prod build. */
  | 'devClientIdField'
  /** Staging: tenant comes from the real host/subdomain; the override field is NOT rendered (prod build). */
  | 'subdomain';

/** How the harness obtains the OTP for a given phone. */
export type OtpStrategy =
  /** Local (and staging-with-FIXED_OTP): a single known constant from E2E_OTP / FIXED_OTP. */
  | 'fixed'
  /** Staging real-MSG91: fetch the just-sent OTP for the phone from a test-only backend hook. */
  | 'fetch';

export interface E2eEnv {
  name: E2eEnvName;
  baseURL: string;
  tenantStrategy: TenantStrategy;
  otpStrategy: OtpStrategy;
  /** The constant OTP, when otpStrategy === 'fixed'. */
  fixedOtp: string;
  /**
   * Template for the test-only OTP-fetch endpoint, when otpStrategy === 'fetch'. `{phone}` and
   * `{clientId}` are substituted. Documented staging-side support: see e2e/README.md.
   */
  otpFetchUrl?: string;
  /** Optional bearer/secret header value guarding the OTP-fetch endpoint (kept out of prod paths). */
  otpFetchToken?: string;
}

const ENV_NAME = (process.env.E2E_ENV ?? 'local').toLowerCase() as E2eEnvName;

/** Per-env defaults. Any field can still be overridden by its dedicated env var below. */
const DEFAULTS: Record<E2eEnvName, Omit<E2eEnv, 'name'>> = {
  local: {
    baseURL: 'http://localhost:3000',
    // Default to hostHeader (local prod-build). See TenantStrategy docs for why `next dev`/devClientIdField
    // no longer works post-AF-6/Turbopack. Run: `next build` then `next start -p 3100` and point at :3100.
    tenantStrategy: 'hostHeader',
    otpStrategy: 'fixed',
    fixedOtp: '123456',
  },
  staging: {
    // No hardcoded staging URL — it MUST be supplied via E2E_BASE_URL (so a misconfigured run fails
    // loudly rather than silently pointing somewhere wrong). See the guard in resolveEnv().
    baseURL: '',
    tenantStrategy: 'subdomain',
    // Default to 'fetch' (real MSG91). If staging's backend has FIXED_OTP set, pass E2E_OTP_STRATEGY=fixed.
    otpStrategy: 'fetch',
    fixedOtp: '123456',
  },
};

let cached: E2eEnv | undefined;

/** Validate an enum-ish env var: undefined → undefined (use default); a bad value → throw loudly. */
function oneOf<T extends string>(raw: string | undefined, allowed: T[], name: string): T | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!(allowed as string[]).includes(raw)) {
    throw new Error(`${name}="${raw}" is invalid; expected one of: ${allowed.join(', ')}`);
  }
  return raw as T;
}

export function resolveEnv(): E2eEnv {
  if (cached) return cached;
  const name: E2eEnvName = ENV_NAME === 'staging' ? 'staging' : 'local';
  const d = DEFAULTS[name];

  const baseURL = process.env.E2E_BASE_URL ?? d.baseURL;
  const tenantStrategy = oneOf<TenantStrategy>(
    process.env.E2E_TENANT_STRATEGY,
    ['hostHeader', 'devClientIdField', 'subdomain'],
    'E2E_TENANT_STRATEGY',
  ) ?? d.tenantStrategy;
  const otpStrategy = oneOf<OtpStrategy>(
    process.env.E2E_OTP_STRATEGY,
    ['fixed', 'fetch'],
    'E2E_OTP_STRATEGY',
  ) ?? d.otpStrategy;
  // E2E_OTP keeps its historical name/role (the fixed OTP); falls back to the env default (123456).
  const fixedOtp = process.env.E2E_OTP ?? d.fixedOtp;

  if (name === 'staging' && !baseURL) {
    throw new Error(
      'E2E_ENV=staging requires E2E_BASE_URL to be set to the staging FE URL (no default — refuses to ' +
        'guess). See e2e/README.md "Running against staging".',
    );
  }
  if (otpStrategy === 'fetch' && !process.env.E2E_OTP_FETCH_URL) {
    throw new Error(
      'OTP strategy "fetch" requires E2E_OTP_FETCH_URL (a test-only endpoint returning the just-sent ' +
        'OTP for a phone). If staging runs with FIXED_OTP, pass E2E_OTP_STRATEGY=fixed + E2E_OTP instead. ' +
        'See e2e/README.md "OTP on staging".',
    );
  }

  cached = {
    name,
    baseURL,
    tenantStrategy,
    otpStrategy,
    fixedOtp,
    otpFetchUrl: process.env.E2E_OTP_FETCH_URL,
    otpFetchToken: process.env.E2E_OTP_FETCH_TOKEN,
  };
  return cached;
}
