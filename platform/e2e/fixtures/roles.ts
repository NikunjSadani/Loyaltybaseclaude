import path from 'node:path';
import { resolveEnv } from './env';

/**
 * Role registry — the real seeded users in `gifsy_dev` (verified 2026-06-19 against the DB).
 * Each role's `scope` + `expected` data is defined by `docs/plans/DATA-VISIBILITY.md` (§2/§3).
 *
 * ⚠️ Env-specific assumptions live in `env.ts`, NOT in the specs: the OTP source (local FIXED_OTP vs
 * staging real-MSG91) and the tenant strategy (local dev clientId override field vs staging
 * subdomain). The `otp` field below is the LOCAL/fixed code; the actual code typed at login is
 * resolved per-env by `helpers/otp.ts`. See playwright.config.ts + ENVIRONMENTS.md.
 */
export interface RoleDef {
  /** file-safe key; storageState is e2e/.auth/<key>.json */
  key: string;
  phone: string;
  /** tenant slug the backend scopes the user lookup to (verify-otp body). */
  clientId: string;
  /** dev fixed OTP; staging would inject a real one. */
  otp: string;
  /** where login should land this role (login/page.tsx getRoleDashboard). */
  expectedDashboardPath: string;
  /** backend UserRole returned on login — ASSERTED in login.ts to catch silent role drift. */
  backendRole: string;
  /** absolute path to the persisted session (CI-safe: not cwd-relative). */
  storageStatePath: string;
}

// The fixed/local OTP (E2E_OTP, default 123456). For staging-with-real-MSG91 the actual code is
// fetched per-login by helpers/otp.ts; this value is then unused. Sourced via env.ts so there is one
// resolution point. Backward-compatible: with no env vars set this is exactly '123456' as before.
const OTP = resolveEnv().fixedOtp;
/** Absolute auth dir so setup-write and config-read agree regardless of cwd (CI runs from repo root). */
export const AUTH_DIR = path.resolve(__dirname, '..', '.auth');
const stateFor = (key: string) => path.join(AUTH_DIR, `${key}.json`);

function role(r: Omit<RoleDef, 'storageStatePath'>): RoleDef {
  return { ...r, storageStatePath: stateFor(r.key) };
}

export const ROLES = {
  partner: role({
    key: 'partner',
    phone: '9000000002',
    clientId: 'deoleo',
    otp: OTP,
    expectedDashboardPath: '/partner/dashboard',
    backendRole: 'WHOLESALER',
  }),
  clientAdmin: role({
    key: 'clientAdmin',
    phone: '9000000001',
    clientId: 'deoleo',
    otp: OTP,
    expectedDashboardPath: '/admin/dashboard',
    backendRole: 'CLIENT_ADMIN',
  }),
  sales: role({
    key: 'sales',
    phone: '9000000003',
    clientId: 'deoleo',
    otp: OTP,
    expectedDashboardPath: '/sales/dashboard',
    backendRole: 'SALES_SO',
  }),
  // The SECOND tenant's admin — logs in via the dev clientId override (#39). Used to prove the
  // REVERSE cross-tenant direction: clientb must not see deoleo's data (gap #52 bidirectional).
  clientbAdmin: role({
    key: 'clientbAdmin',
    phone: '9000000020',
    clientId: 'clientb',
    otp: OTP,
    expectedDashboardPath: '/admin/dashboard',
    backendRole: 'CLIENT_ADMIN',
  }),
  // GIFSY logs in via the dev clientId override field on LOCAL (#39 fixed, task #53) and via the
  // host/subdomain on STAGING — the same real-login path as every other role. It is a live
  // SESSION_ROLE (setup/auth.setup.ts) and its specs (gifsy/*.e2e.ts) are green.
  gifsy: role({
    key: 'gifsy',
    phone: '9830011252',
    clientId: 'gifsy',
    otp: OTP,
    expectedDashboardPath: '/gifsy',
    backendRole: 'GIFSY_ADMIN',
  }),
  // MIS_USER — read-only tenant role (no write controls); sees the same admin
  // surface as CLIENT_ADMIN but all mutating actions are hidden/403.
  // Seeded as id=seed-deoleo-mis (phone 9000000004) in api/prisma/seed.ts §3.1b.
  mis: role({
    key: 'mis',
    phone: '9000000004',
    clientId: 'deoleo',
    otp: OTP,
    expectedDashboardPath: '/admin/dashboard',
    backendRole: 'MIS_USER',
  }),
  // SALES_ASM — area sales manager with the SO (seed-su-1) as a direct report,
  // so /sales/team* returns real roll-up data. Use for Wave-3 team-downline specs.
  // Seeded as id=seed-deoleo-sales-mgr (phone 9000000006) in api/prisma/seed.ts §3.4.
  salesManager: role({
    key: 'salesManager',
    phone: '9000000006',
    clientId: 'deoleo',
    otp: OTP,
    expectedDashboardPath: '/sales/dashboard',
    backendRole: 'SALES_ASM',
  }),
} satisfies Record<string, RoleDef>;

export type RoleKey = keyof typeof ROLES;
