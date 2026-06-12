/**
 * TDD — schemes.ts
 *
 * Covers:
 *  1. Core enrollment cross-check (self-enroll vs sales-team enroll)
 *  2. getAdminSchemes() — reads from localStorage
 *  3. seedAdminSchemes() — idempotent seed for demo data
 *  4. getAllPendingSchemes() — reads ONLY from admin-published schemes (no MOCK_SCHEMES)
 *  5. getPendingSchemes()   — same, with outlet-type + enrollment filtering
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  acceptScheme,
  saveSalesEnrollment,
  isOutletEnrolledInScheme,
  getPendingSchemes,
  getAllPendingSchemes,
  getAcceptedSchemeIds,
  getSelfEnrollments,
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
const OTHER_OUTLET = 'o5';

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

// ── getPendingSchemes (outlet-type + enrollment filtering) ────────────────────

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

  it('hides a scheme from the partner app after the sales team enrolled that outlet', () => {
    writeScheme(BASE_SCHEME);
    saveSalesEnrollment(SCHEME_ID, OUTLET_ID);
    const pending = getPendingSchemes('SSS', OUTLET_ID);
    expect(pending.find((s) => s.id === SCHEME_ID)).toBeUndefined();
  });

  it('still shows other schemes the outlet has not been enrolled in', () => {
    writeScheme(BASE_SCHEME);
    writeScheme(OTHER_SCHEME);
    saveSalesEnrollment(SCHEME_ID, OUTLET_ID);
    const pending = getPendingSchemes('SSS', OUTLET_ID);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((s) => s.id !== SCHEME_ID)).toBe(true);
  });

  it('hides a scheme the outlet self-accepted', () => {
    writeScheme(BASE_SCHEME);
    acceptScheme(SCHEME_ID, OUTLET_ID);
    const pending = getPendingSchemes('SSS', OUTLET_ID);
    expect(pending.find((s) => s.id === SCHEME_ID)).toBeUndefined();
  });
});

// ── acceptScheme ──────────────────────────────────────────────────────────────

describe('acceptScheme', () => {
  it('stores the schemeId + outletId as a self-enrollment', () => {
    acceptScheme(SCHEME_ID, OUTLET_ID);
    const stored = getSelfEnrollments();
    expect(stored).toHaveLength(1);
    expect(stored[0].schemeId).toBe(SCHEME_ID);
    expect(stored[0].outletId).toBe(OUTLET_ID);
    expect(stored[0].acceptedAt).toBeDefined();
  });

  it('is idempotent — calling twice does not create a duplicate', () => {
    acceptScheme(SCHEME_ID, OUTLET_ID);
    acceptScheme(SCHEME_ID, OUTLET_ID);
    expect(getSelfEnrollments()).toHaveLength(1);
  });

  it('getAcceptedSchemeIds() still returns scheme IDs (backward compat)', () => {
    acceptScheme(SCHEME_ID, OUTLET_ID);
    expect(getAcceptedSchemeIds()).toContain(SCHEME_ID);
  });
});

// ── isOutletEnrolledInScheme ──────────────────────────────────────────────────

describe('isOutletEnrolledInScheme', () => {
  it('returns false when nothing is enrolled', () => {
    expect(isOutletEnrolledInScheme(SCHEME_ID, OUTLET_ID)).toBe(false);
  });

  it('returns true when the outlet enrolled via the sales team', () => {
    saveSalesEnrollment(SCHEME_ID, OUTLET_ID);
    expect(isOutletEnrolledInScheme(SCHEME_ID, OUTLET_ID)).toBe(true);
  });

  it('returns true when the outlet self-enrolled via the partner app', () => {
    acceptScheme(SCHEME_ID, OUTLET_ID);
    expect(isOutletEnrolledInScheme(SCHEME_ID, OUTLET_ID)).toBe(true);
  });

  it('returns false for a different outlet even if the scheme is self-enrolled by another outlet', () => {
    acceptScheme(SCHEME_ID, OTHER_OUTLET);
    expect(isOutletEnrolledInScheme(SCHEME_ID, OUTLET_ID)).toBe(false);
  });

  it('returns false for a different scheme even if the outlet enrolled in another scheme', () => {
    saveSalesEnrollment('other_scheme', OUTLET_ID);
    expect(isOutletEnrolledInScheme(SCHEME_ID, OUTLET_ID)).toBe(false);
  });

  it('returns false when schemeId matches but outletId differs (sales enrollment)', () => {
    saveSalesEnrollment(SCHEME_ID, OTHER_OUTLET);
    expect(isOutletEnrolledInScheme(SCHEME_ID, OUTLET_ID)).toBe(false);
  });
});

// ── getPendingSchemes cross-check with isOutletEnrolledInScheme ───────────────

describe('getPendingSchemes cross-checks', () => {
  it('hides a scheme the outlet self-accepted when the sales team queries', () => {
    acceptScheme(SCHEME_ID, OUTLET_ID);
    expect(isOutletEnrolledInScheme(SCHEME_ID, OUTLET_ID)).toBe(true);
  });
});
