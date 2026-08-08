/**
 * Outlet Master upload — Parent ID validation + parked-target flagging.
 *
 * Covers the two preview-validation additions:
 *   - Parent ID is checked against the tenant's owner-group codes UPFRONT (case-sensitive,
 *     exactly like the backend), so a wrong code (e.g. the outlet's own name typed into
 *     Parent ID) is an ERROR in the preview instead of a silent post-Confirm backend reject.
 *   - A row targeting a PARKED outlet is flagged `parked` (a warning, not an error), so the
 *     master upload never silently "succeeds" on a hidden outlet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { gifsyMock } = vi.hoisted(() => ({ gifsyMock: { upiEnabled: false } }));
vi.mock('@/lib/gifsy-settings', () => ({
  getGifsySettings: () => ({ salesApp: { upiEnabled: gifsyMock.upiEnabled } }),
}));

import { validateOutletUpload } from '../outlet-upload';
import type { OutletUploadRow, OutletRecord } from '@/types';
import { MOCK_EMPLOYEES } from '../employee-hierarchy';

const LEAF_ROLE_CODE   = 'XSR';
const VALID_PROGRAMS   = ['Trade Loyalty', 'Gold Programme'];
const VALID_CATEGORIES = ['Premium', 'Standard', 'Economy'];
const VALID_OUTLET_TYPES = ['SSS', 'WHOLESALER', 'SUB_STOCKIST', 'SSS_TOT'];

function makeRow(overrides: Partial<OutletUploadRow> = {}): OutletUploadRow {
  return {
    rowNum: 2, outletId: 'OUT-TEST-001', outletName: 'Verma Traders',
    programName: 'Trade Loyalty', programCategory: 'Standard', outletType: 'SSS',
    beat: 'Andheri Beat', distributorId: 'DIST-01', distributorName: 'ABC Distributors',
    metro: 'Yes', city: 'Mumbai', state: 'Maharashtra', zone: '',
    xsrId: 'ISR-M001', payoutMethod: '', parentId: '', ...overrides,
  };
}

function validate(
  rows: OutletUploadRow[],
  existing: Pick<OutletRecord, 'outletId' | 'isActive'>[] = [],
  parentCodes?: Set<string>,
  parkedIds?: Set<string>,
) {
  return validateOutletUpload(
    rows, existing, VALID_PROGRAMS, VALID_CATEGORIES, VALID_OUTLET_TYPES,
    MOCK_EMPLOYEES, LEAF_ROLE_CODE, parentCodes, parkedIds,
  );
}

beforeEach(() => { gifsyMock.upiEnabled = false; });

describe('Outlet Master — Parent ID validation', () => {
  it('flags a Parent ID that is not a known owner group (the exact silent failure)', () => {
    // "Food Junction" (the outlet name) typed into Parent ID, tenant has one real group.
    const res = validate([makeRow({ parentId: 'Food Junction' })], [], new Set(['CPP01']));
    expect(res.rows[0].status).toBe('ERROR');
    expect(res.rows[0].errors.join(' ')).toContain('Parent ID "Food Junction" is not an existing owner group');
    expect(res.canProceed).toBe(false);
  });

  it('accepts a Parent ID that matches an existing owner group', () => {
    const res = validate([makeRow({ parentId: 'CPP01' })], [], new Set(['CPP01']));
    expect(res.rows[0].status).toBe('OK');
  });

  it('is case-sensitive (matches the backend), so a case typo is caught', () => {
    const res = validate([makeRow({ parentId: 'cpp01' })], [], new Set(['CPP01']));
    expect(res.rows[0].status).toBe('ERROR');
  });

  it('enforces even when the tenant has NO groups (empty set) — any Parent ID is then invalid', () => {
    const res = validate([makeRow({ parentId: 'Food Junction' })], [], new Set());
    expect(res.rows[0].status).toBe('ERROR');
  });

  it('skips Parent ID validation when the group list did not load (undefined) — backend still checks', () => {
    const res = validate([makeRow({ parentId: 'Whatever' })], [], undefined);
    expect(res.rows[0].status).toBe('OK');
  });

  it('a blank Parent ID is always fine (grouping unchanged)', () => {
    const res = validate([makeRow({ parentId: '' })], [], new Set(['CPP01']));
    expect(res.rows[0].status).toBe('OK');
  });
});

describe('Outlet Master — parked-target flagging', () => {
  it('flags a row whose outlet is parked as parked=true, still OK (warning, not error)', () => {
    const existing = [{ outletId: 'OUT-PARK-1', isActive: false }];
    const res = validate(
      [makeRow({ outletId: 'OUT-PARK-1' })],
      existing,
      undefined,
      new Set(['OUT-PARK-1']),
    );
    expect(res.rows[0].status).toBe('OK');
    expect(res.rows[0].parked).toBe(true);
  });

  it('does not flag a non-parked target', () => {
    const existing = [{ outletId: 'OUT-ACTIVE-1', isActive: true }];
    const res = validate(
      [makeRow({ outletId: 'OUT-ACTIVE-1' })],
      existing,
      undefined,
      new Set(['SOME-OTHER-ID']),
    );
    expect(res.rows[0].parked).toBeFalsy();
  });

  it('parked flag is absent when no parked set is provided', () => {
    const res = validate([makeRow()], []);
    expect(res.rows[0].parked).toBeFalsy();
  });
});
