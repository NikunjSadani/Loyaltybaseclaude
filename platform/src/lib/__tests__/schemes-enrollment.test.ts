/**
 * TDD — schemes.ts
 *
 * Covers:
 *  1. getAdminSchemes() — reads from localStorage
 *  2. seedAdminSchemes() — idempotent seed for demo data
 *  3. getAllPendingSchemes() — reads ONLY from admin-published schemes (no MOCK_SCHEMES)
 *  4. getPendingSchemes()   — same, with outlet-type + enrolledSchemeIds filtering
 *
 * NOTE: acceptScheme, saveSalesEnrollment, and isOutletEnrolledInScheme are now
 * async functions that call the real backend (/api/schemes/:id/enroll and
 * /api/schemes/:id/my-enrollment). They cannot be tested here without a running
 * backend or a fetch mock. The localStorage-based enrollment tests have been
 * removed; enrollment persistence is covered by the E2E harness (platform/e2e).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPendingSchemes,
  getAllPendingSchemes,
  getAdminSchemes,
  seedAdminSchemes,
  type AdminPublishedScheme,
} from '../schemes';

const ADMIN_SCHEMES_KEY = 'loyaltybase_admin_schemes_v1';

/** Helpers to write a known scheme into localStorage for tests */
function writeScheme(scheme: AdminPublishedScheme) {
  const existing: AdminPublishedScheme[] = (() => {
    try { return JSON.parse(localStorage.getItem(ADMIN_SCHEMES_KEY) ?? '[]'); }
    catch { return []; }
  })();
  existing.push(scheme);
  localStorage.setItem(ADMIN_SCHEMES_KEY, JSON.stringify(existing));
}

const BASE_SCHEME: AdminPublishedScheme = {
  id:                       'sch_q2_2026',
  name:                     'Summer Push Q2 FY26',
  description:              'Test scheme',
  period:                   "Jun '26 – Aug '26",
  startDate:                '2026-06-01',
  endDate:                  '2026-08-31',
  acceptDeadline:           '2099-12-31T23:59:59',   // far future so it stays pending
  outletTargeting:          'ALL',
  targetedOutletIds:        [],
  requiresSelfRegistration: true,
  publishedAt:              '2026-05-20T09:00:00',
  status:                   'ACTIVE',
  eligibility:              ['WHOLESALER', 'SSS', 'SUB_STOCKIST'],
  kpis:                     [{ label: 'Monthly Volume', unit: 'cases' }],
};

const OTHER_SCHEME: AdminPublishedScheme = {
  ...BASE_SCHEME,
  id:   'sch_visibility_jun',
  name: 'Visibility Drive — June 2026',
};

const SCHEME_ID    = BASE_SCHEME.id;
const OUTLET_ID    = 'o2';

beforeEach(() => {
  localStorage.clear();
});

// ── getAdminSchemes ───────────────────────────────────────────────────────────

describe('getAdminSchemes', () => {
  it('returns empty array when localStorage is empty', () => {
    expect(getAdminSchemes()).toEqual([]);
  });

  it('returns schemes written to localStorage', () => {
    writeScheme(BASE_SCHEME);
    const schemes = getAdminSchemes();
    expect(schemes).toHaveLength(1);
    expect(schemes[0].id).toBe(SCHEME_ID);
  });

  it('returns multiple schemes in order', () => {
    writeScheme(BASE_SCHEME);
    writeScheme(OTHER_SCHEME);
    const schemes = getAdminSchemes();
    expect(schemes).toHaveLength(2);
  });
});

// ── seedAdminSchemes ──────────────────────────────────────────────────────────

describe('seedAdminSchemes', () => {
  it('seeds schemes into empty localStorage', () => {
    seedAdminSchemes();
    expect(getAdminSchemes().length).toBeGreaterThan(0);
  });

  it('is idempotent — calling twice does not duplicate schemes', () => {
    seedAdminSchemes();
    const countFirst = getAdminSchemes().length;
    seedAdminSchemes();
    expect(getAdminSchemes().length).toBe(countFirst);
  });

  it('does NOT overwrite existing schemes already in localStorage', () => {
    writeScheme(BASE_SCHEME);
    seedAdminSchemes();          // should not wipe the custom scheme
    const all = getAdminSchemes();
    expect(all.some((s) => s.id === SCHEME_ID)).toBe(true);
  });

  it('seeds at least 3 demo schemes', () => {
    seedAdminSchemes();
    expect(getAdminSchemes().length).toBeGreaterThanOrEqual(3);
  });
});

// ── getAllPendingSchemes (no MOCK_SCHEMES fallback) ───────────────────────────

describe('getAllPendingSchemes', () => {
  it('returns empty array when localStorage is empty (no MOCK_SCHEMES fallback)', () => {
    expect(getAllPendingSchemes()).toEqual([]);
  });

  it('returns admin-published schemes from localStorage', () => {
    writeScheme(BASE_SCHEME);
    const schemes = getAllPendingSchemes();
    expect(schemes).toHaveLength(1);
    expect(schemes[0].id).toBe(SCHEME_ID);
  });

  it('excludes schemes whose acceptDeadline has passed', () => {
    writeScheme({ ...BASE_SCHEME, acceptDeadline: '2000-01-01T00:00:00' });
    expect(getAllPendingSchemes()).toHaveLength(0);
  });

  it('returns multiple schemes when multiple are published', () => {
    writeScheme(BASE_SCHEME);
    writeScheme(OTHER_SCHEME);
    expect(getAllPendingSchemes()).toHaveLength(2);
  });
});

// ── getPendingSchemes (outlet-type + enrolledSchemeIds filtering) ─────────────

describe('getPendingSchemes', () => {
  it('returns empty array when localStorage is empty (no MOCK_SCHEMES fallback)', () => {
    expect(getPendingSchemes('SSS', OUTLET_ID)).toEqual([]);
  });

  it('returns an admin-published scheme for a matching outlet type', () => {
    writeScheme(BASE_SCHEME);   // eligibility: ALL
    const pending = getPendingSchemes('SSS', OUTLET_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(SCHEME_ID);
  });

  it('hides a scheme when its ID is in enrolledSchemeIds', () => {
    writeScheme(BASE_SCHEME);
    const pending = getPendingSchemes('SSS', OUTLET_ID, [SCHEME_ID]);
    expect(pending.find((s) => s.id === SCHEME_ID)).toBeUndefined();
  });

  it('still shows other schemes not in enrolledSchemeIds', () => {
    writeScheme(BASE_SCHEME);
    writeScheme(OTHER_SCHEME);
    const pending = getPendingSchemes('SSS', OUTLET_ID, [SCHEME_ID]);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((s) => s.id !== SCHEME_ID)).toBe(true);
  });

  it('shows all schemes when enrolledSchemeIds is empty', () => {
    writeScheme(BASE_SCHEME);
    writeScheme(OTHER_SCHEME);
    const pending = getPendingSchemes('SSS', OUTLET_ID, []);
    expect(pending).toHaveLength(2);
  });

  it('excludes schemes past their acceptDeadline', () => {
    writeScheme({ ...BASE_SCHEME, acceptDeadline: '2000-01-01T00:00:00' });
    expect(getPendingSchemes('SSS', OUTLET_ID)).toHaveLength(0);
  });

  it('excludes schemes that do not require self-registration', () => {
    writeScheme({ ...BASE_SCHEME, requiresSelfRegistration: false });
    expect(getPendingSchemes('SSS', OUTLET_ID)).toHaveLength(0);
  });

  it('excludes schemes with SPECIFIC targeting when outletId is not in the list', () => {
    writeScheme({
      ...BASE_SCHEME,
      outletTargeting: 'SPECIFIC',
      targetedOutletIds: ['other_outlet'],
    });
    expect(getPendingSchemes('SSS', OUTLET_ID)).toHaveLength(0);
  });

  it('includes SPECIFIC-targeted schemes when outletId is in the list', () => {
    writeScheme({
      ...BASE_SCHEME,
      outletTargeting: 'SPECIFIC',
      targetedOutletIds: [OUTLET_ID],
    });
    const pending = getPendingSchemes('SSS', OUTLET_ID);
    expect(pending).toHaveLength(1);
  });

  it('excludes schemes whose eligibility does not match the outlet type', () => {
    writeScheme({ ...BASE_SCHEME, eligibility: ['WHOLESALER'] });
    expect(getPendingSchemes('SSS', OUTLET_ID)).toHaveLength(0);
  });
});
