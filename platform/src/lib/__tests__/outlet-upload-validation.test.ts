/**
 * Outlet Upload Validation — Pure Logic Tests
 *
 * Tests cover the upload flows:
 *   O1–O5   : Header validation (outlet master)
 *   O6–O14  : Row validation — happy paths (outlet master — CREATE)
 *   O15–O26 : Row validation — error cases (outlet master — CREATE)
 *   O31–O35 : Re-KYC flag upload validation
 *   O36, O38: Utility functions
 *   O41–O42 : Re-KYC flag header validation
 *   O43–O53 : Outlet deactivation validation
 *   O54     : Outlet addition — underscore in outlet ID is rejected (M2 fix)
 *   O57     : Re-KYC — outlet with kycStatus=NOT_STARTED is rejected (H3 fix)
 *   O70–O78 : Outlet master — UPDATE and REACTIVATE (upsert behaviour)
 *   O79     : Outlet master — summary counts creates/updates/reactivates
 *   O80–O81 : Re-KYC — Outlet Name as a flaggable field
 */

import { describe, it, expect } from 'vitest';
import {
  OUTLET_UPLOAD_HEADERS,
  REKYC_FLAG_HEADERS,
  REKYC_FIELD_KEYS,
  DEACTIVATE_HEADERS,
  validateOutletUploadHeaders,
  validateReKYCFlagHeaders,
  validateDeactivateHeaders,
  validateOutletUpload,
  validateReKYCFlagUpload,
  validateDeactivateUpload,
  parseOutletUploadRows,
  parseReKYCFlagRows,
  parseDeactivateRows,
  getOutletAdditionTemplateData,
  isYes,
} from '../outlet-upload';
import type {
  OutletUploadRow,
  ReKYCFlagRow,
  OutletRecord,
} from '@/types';
import { KYCStatus } from '@/types';
import { MOCK_EMPLOYEES, DEOLEO_HIERARCHY } from '../employee-hierarchy';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LEAF_ROLE_CODE = 'XSR'; // for Deoleo

const VALID_PROGRAMS   = ['Trade Loyalty', 'Gold Programme'];
const VALID_CATEGORIES = ['Premium', 'Standard', 'Economy'];

/** Build a minimal valid outlet upload row (for CREATE — new outlet) */
function makeRow(overrides: Partial<OutletUploadRow> = {}): OutletUploadRow {
  return {
    rowNum:          2,
    outletId:        'OUT-TEST-001',
    outletName:      'Verma Traders',
    programName:     'Trade Loyalty',
    programCategory: 'Standard',
    outletType:      'SSS',
    beat:            'Andheri Beat',
    distributorId:   'DIST-01',
    distributorName: 'ABC Distributors',
    metro:           'Yes',
    city:            'Mumbai',
    state:           'Maharashtra',
    zone:            '',
    xsrId:           'ISR-M001',  // must be a leaf in MOCK_EMPLOYEES
    ...overrides,
  };
}

/**
 * Existing outlets for Re-KYC tests (needs kycStatus).
 * Also used as the existingOutlets arg for re-KYC validation.
 */
const EXISTING_OUTLETS: Pick<OutletRecord, 'outletId' | 'kycStatus'>[] = [
  { outletId: 'OUT-2026-K01',    kycStatus: KYCStatus.APPROVED      },
  { outletId: 'OUT-2026-K02',    kycStatus: KYCStatus.APPROVED      },
  { outletId: 'OUT-2026-K03',    kycStatus: KYCStatus.APPROVED      },
  { outletId: 'OUT-NOT-STARTED', kycStatus: KYCStatus.NOT_STARTED   },
];

/**
 * Existing outlets for outlet master (upsert) tests (needs isActive).
 */
const OUTLET_UPLOAD_EXISTING: Pick<OutletRecord, 'outletId' | 'isActive'>[] = [
  { outletId: 'OUT-ACTIVE-01',   isActive: true  },
  { outletId: 'OUT-ACTIVE-02',   isActive: true  },
  { outletId: 'OUT-INACTIVE-01', isActive: false },
];

// ─── O1–O5: Header validation — outlet master ────────────────────────────────

describe('outlet master header validation', () => {
  it('O1 — accepts exact required headers', () => {
    expect(validateOutletUploadHeaders(OUTLET_UPLOAD_HEADERS)).toBeNull();
  });

  it('O2 — accepts headers with extra columns (superset)', () => {
    expect(validateOutletUploadHeaders([...OUTLET_UPLOAD_HEADERS, 'Extra Column'])).toBeNull();
  });

  it('O3 — rejects when a required header is missing', () => {
    const without = OUTLET_UPLOAD_HEADERS.filter(h => h !== 'XSR ID');
    expect(validateOutletUploadHeaders(without)).toMatch(/XSR ID/);
  });

  it('O4 — lists all missing headers when multiple are absent', () => {
    const without = OUTLET_UPLOAD_HEADERS.filter(h => h !== 'Outlet ID' && h !== 'State');
    const result  = validateOutletUploadHeaders(without);
    expect(result).toMatch(/Outlet ID/);
    expect(result).toMatch(/State/);
  });

  it('O5 — is case-sensitive (lowercase headers rejected)', () => {
    const lower = OUTLET_UPLOAD_HEADERS.map(h => h.toLowerCase());
    expect(validateOutletUploadHeaders(lower)).not.toBeNull();
  });
});

// ─── O6–O14: Row validation — happy paths (CREATE) ───────────────────────────

describe('outlet master row validation — happy paths (CREATE)', () => {
  it('O6 — valid RETAILER row creates outlet', () => {
    const result = validateOutletUpload([makeRow()], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.headerError).toBeNull();
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].action).toBe('CREATE');
    expect(result.canProceed).toBe(true);
  });

  it('O7 — valid WHOLESALER row', () => {
    const result = validateOutletUpload([makeRow({ outletType: 'WHOLESALER' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('OK');
  });

  it('O8 — valid SUB_STOCKIST row', () => {
    const result = validateOutletUpload([makeRow({ outletType: 'SUB_STOCKIST' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('OK');
  });

  it('O9 — valid SSS_TOT row', () => {
    const result = validateOutletUpload([makeRow({ outletType: 'SSS_TOT' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('OK');
  });

  it('O10 — metro "No" is accepted', () => {
    const result = validateOutletUpload([makeRow({ metro: 'No' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('OK');
  });

  it('O11 — metro case-insensitive ("yes" and "YES" accepted)', () => {
    const r1 = validateOutletUpload([makeRow({ metro: 'yes' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    const r2 = validateOutletUpload([makeRow({ metro: 'YES' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(r1.rows[0].status).toBe('OK');
    expect(r2.rows[0].status).toBe('OK');
  });

  it('O12 — distributor ID and name are optional (empty accepted)', () => {
    const result = validateOutletUpload([makeRow({ distributorId: '', distributorName: '' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('OK');
  });

  it('O13 — multiple valid rows all pass, summary is correct', () => {
    const rows = [
      makeRow({ outletId: 'OUT-A', rowNum: 2 }),
      makeRow({ outletId: 'OUT-B', rowNum: 3 }),
      makeRow({ outletId: 'OUT-C', rowNum: 4 }),
    ];
    const result = validateOutletUpload(rows, [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.summary.total).toBe(3);
    expect(result.summary.creates).toBe(3);
    expect(result.summary.updates).toBe(0);
    expect(result.summary.reactivates).toBe(0);
    expect(result.summary.errors).toBe(0);
    expect(result.canProceed).toBe(true);
  });

  it('O14 — blank/whitespace-only row is skipped (no error)', () => {
    const blankRow: OutletUploadRow = {
      rowNum: 2, outletId: '', outletName: '', programName: '', programCategory: '',
      outletType: '', beat: '', distributorId: '', distributorName: '', metro: '',
      city: '', state: '', zone: '', xsrId: '',
    };
    const result = validateOutletUpload([blankRow], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows).toHaveLength(0);
  });
});

// ─── O15–O26: Row validation — error cases (CREATE) ──────────────────────────

describe('outlet master row validation — errors (CREATE)', () => {
  it('O15 — missing outlet ID is an error', () => {
    const result = validateOutletUpload([makeRow({ outletId: '' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /outlet id/i.test(e))).toBe(true);
  });

  it('O16 — outlet ID with invalid chars is an error', () => {
    const result = validateOutletUpload([makeRow({ outletId: 'OUT 001 @#' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /alphanumeric/i.test(e))).toBe(true);
  });

  it('O17 — duplicate outlet ID within upload is an error (second row fails)', () => {
    const rows = [
      makeRow({ outletId: 'OUT-DUP', rowNum: 2 }),
      makeRow({ outletId: 'OUT-DUP', rowNum: 3 }),
    ];
    const result = validateOutletUpload(rows, [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    const errors = result.rows.filter(r => r.status === 'ERROR');
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.some(r => r.errors.some(e => /duplicate/i.test(e)))).toBe(true);
  });

  it('O18 — existing active outlet → action UPDATE, status OK (upsert, not error)', () => {
    const result = validateOutletUpload(
      [makeRow({ outletId: 'OUT-ACTIVE-01', xsrId: 'ISR-M001' })],
      OUTLET_UPLOAD_EXISTING,
      VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].action).toBe('UPDATE');
  });

  it('O19 — missing outlet name is an error for new outlets', () => {
    const result = validateOutletUpload([makeRow({ outletName: '' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /outlet name/i.test(e))).toBe(true);
  });

  it('O20 — invalid outlet type is an error', () => {
    const result = validateOutletUpload([makeRow({ outletType: 'KIRANA' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /outlet type/i.test(e))).toBe(true);
  });

  it('O21 — program name not in configured list is an error', () => {
    const result = validateOutletUpload([makeRow({ programName: 'Unknown Programme' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /program name/i.test(e))).toBe(true);
  });

  it('O22 — program category not in configured list is an error', () => {
    const result = validateOutletUpload([makeRow({ programCategory: 'Unknown Cat' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /program category/i.test(e))).toBe(true);
  });

  it('O23 — metro value not Yes/No is an error', () => {
    const result = validateOutletUpload([makeRow({ metro: 'Maybe' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /metro/i.test(e))).toBe(true);
  });

  it('O24 — missing XSR ID is an error for new outlets', () => {
    const result = validateOutletUpload([makeRow({ xsrId: '' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /xsr id/i.test(e))).toBe(true);
  });

  it('O25 — XSR ID not found in employee hierarchy is an error', () => {
    const result = validateOutletUpload([makeRow({ xsrId: 'GHOST-99' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /not found/i.test(e))).toBe(true);
  });

  it('O26 — XSR ID exists but is NOT a leaf-level role is an error', () => {
    const result = validateOutletUpload([makeRow({ xsrId: 'NSM-01' })], [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /leaf|XSR/i.test(e))).toBe(true);
  });
});

// ─── O31–O35: Re-KYC flag upload validation ──────────────────────────────────

describe('re-KYC flag upload validation', () => {
  function makeReKYCRow(overrides: Partial<ReKYCFlagRow> = {}): ReKYCFlagRow {
    return {
      rowNum:          2,
      outletId:        'OUT-2026-K01',
      outletName:      '',
      ownerName:       'Yes',
      mobileNumber:    '',
      gstNumber:       '',
      panNumber:       '',
      streetAddress:   '',
      city:            '',
      pincode:         '',
      state:           '',
      bankName:          '',
      accountHolderName: '',
      accountNumber:     '',
      ifscCode:          '',
      upiId:             '',
      gstCertificate:    '',
      ownerPhoto:        '',
      addressProof:      '',
      storeBoardPhoto:   '',
      cancelledCheque: '',
      selfDeclaration: '',
      remarks:         'Owner name changed',
      ...overrides,
    };
  }

  it('O31 — row with at least one "Yes" field is accepted', () => {
    const result = validateReKYCFlagUpload([makeReKYCRow()], EXISTING_OUTLETS);
    expect(result.headerError).toBeNull();
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].flagCount).toBe(1);
    expect(result.canProceed).toBe(true);
  });

  it('O32 — row with no "Yes" fields is an error', () => {
    const result = validateReKYCFlagUpload([makeReKYCRow({ ownerName: '' })], EXISTING_OUTLETS);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /at least one/i.test(e))).toBe(true);
  });

  it('O33 — outlet ID not in system is an error', () => {
    const result = validateReKYCFlagUpload([makeReKYCRow({ outletId: 'GHOST-99' })], EXISTING_OUTLETS);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /not found/i.test(e))).toBe(true);
  });

  it('O34 — "yes" case-insensitive (YES, yes, Yes all count)', () => {
    const r1 = validateReKYCFlagUpload([makeReKYCRow({ ownerName: 'YES' })], EXISTING_OUTLETS);
    const r2 = validateReKYCFlagUpload([makeReKYCRow({ ownerName: 'yes' })], EXISTING_OUTLETS);
    const r3 = validateReKYCFlagUpload([makeReKYCRow({ ownerName: 'Yes' })], EXISTING_OUTLETS);
    expect(r1.rows[0].status).toBe('OK');
    expect(r2.rows[0].status).toBe('OK');
    expect(r3.rows[0].status).toBe('OK');
  });

  it('O35 — flagCount is accurate when multiple fields marked Yes', () => {
    const result = validateReKYCFlagUpload(
      [makeReKYCRow({ ownerName: 'Yes', mobileNumber: 'Yes', gstCertificate: 'Yes' })],
      EXISTING_OUTLETS,
    );
    expect(result.rows[0].flagCount).toBe(3);
  });
});

// ─── O36, O38: Utility functions ─────────────────────────────────────────────

describe('utility functions', () => {
  it('O36 — parseOutletUploadRows maps raw record keys to OutletUploadRow', () => {
    const raw = [{
      'Outlet ID': 'OUT-001', 'Outlet Name': 'Test Shop', 'Program Name': 'Trade Loyalty',
      'Program Category': 'Standard', 'Outlet Type': 'SSS', 'Beat': 'Andheri Beat',
      'Distributor ID': 'D1', 'Distributor Name': 'Dist 1', 'Metro': 'Yes',
      'City': 'Mumbai', 'State': 'Maharashtra', 'XSR ID': 'ISR-M001',
    }];
    const rows = parseOutletUploadRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0].outletId).toBe('OUT-001');
    expect(rows[0].outletName).toBe('Test Shop');
    expect(rows[0].xsrId).toBe('ISR-M001');
    expect(rows[0].rowNum).toBe(2);
  });

  it('O38 — isYes returns true for Yes/YES/yes, false for everything else', () => {
    expect(isYes('Yes')).toBe(true);
    expect(isYes('YES')).toBe(true);
    expect(isYes('yes')).toBe(true);
    expect(isYes('')).toBe(false);
    expect(isYes('No')).toBe(false);
    expect(isYes('no')).toBe(false);
    expect(isYes('1')).toBe(false);
  });
});

// ─── O41–O42: Re-KYC flag header validation ──────────────────────────────────

describe('re-KYC flag header validation', () => {
  it('O41 — accepts exact re-KYC flag headers', () => {
    expect(validateReKYCFlagHeaders(REKYC_FLAG_HEADERS)).toBeNull();
  });

  it('O42 — rejects missing re-KYC flag header', () => {
    const without = REKYC_FLAG_HEADERS.filter(h => h !== 'Outlet ID');
    expect(validateReKYCFlagHeaders(without)).toMatch(/Outlet ID/);
  });
});

// ─── O43–O45: Outlet deactivation — header validation ────────────────────────

describe('outlet deactivation header validation', () => {
  it('O43 — accepts exact deactivate header', () => {
    expect(validateDeactivateHeaders(DEACTIVATE_HEADERS)).toBeNull();
  });

  it('O44 — rejects empty headers', () => {
    expect(validateDeactivateHeaders([])).toMatch(/Outlet ID/);
  });

  it('O45 — rejects wrong header name', () => {
    expect(validateDeactivateHeaders(['outlet_id'])).toMatch(/Outlet ID/);
  });
});

// ─── O46–O53: Outlet deactivation — row validation ───────────────────────────

const ACTIVE_OUTLETS = [
  { outletId: 'OUT-001', isActive: true  },
  { outletId: 'OUT-002', isActive: true  },
  { outletId: 'OUT-003', isActive: false },
];

describe('outlet deactivation upload validation', () => {
  it('O46 — valid deactivation of an active outlet', () => {
    const rows   = parseDeactivateRows([{ 'Outlet ID': 'OUT-001' }]);
    const result = validateDeactivateUpload(rows, ACTIVE_OUTLETS);
    expect(result.headerError).toBeNull();
    expect(result.hasErrors).toBe(false);
    expect(result.canProceed).toBe(true);
    expect(result.rows[0].status).toBe('OK');
    expect(result.summary.deactivates).toBe(1);
    expect(result.summary.errors).toBe(0);
  });

  it('O47 — outlet ID not found in system is an error', () => {
    const rows   = parseDeactivateRows([{ 'Outlet ID': 'OUT-999' }]);
    const result = validateDeactivateUpload(rows, ACTIVE_OUTLETS);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors[0]).toMatch(/not found/i);
    expect(result.canProceed).toBe(false);
  });

  it('O48 — outlet that is already inactive is an error', () => {
    const rows   = parseDeactivateRows([{ 'Outlet ID': 'OUT-003' }]);
    const result = validateDeactivateUpload(rows, ACTIVE_OUTLETS);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors[0]).toMatch(/already inactive/i);
  });

  it('O49 — duplicate outlet ID within the upload is an error', () => {
    const rows = parseDeactivateRows([
      { 'Outlet ID': 'OUT-001' },
      { 'Outlet ID': 'OUT-001' },
    ]);
    const result = validateDeactivateUpload(rows, ACTIVE_OUTLETS);
    expect(result.rows[1].status).toBe('ERROR');
    expect(result.rows[1].errors[0]).toMatch(/duplicate/i);
  });

  it('O50 — outlet ID with invalid characters is an error', () => {
    const rows   = parseDeactivateRows([{ 'Outlet ID': 'OUT 001 !!' }]);
    const result = validateDeactivateUpload(rows, ACTIVE_OUTLETS);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors[0]).toMatch(/invalid/i);
  });

  it('O51 — blank rows are silently skipped', () => {
    const rows = parseDeactivateRows([
      { 'Outlet ID': '' },
      { 'Outlet ID': 'OUT-001' },
    ]);
    const result = validateDeactivateUpload(rows, ACTIVE_OUTLETS);
    expect(result.rows).toHaveLength(1);
    expect(result.summary.total).toBe(1);
  });

  it('O52 — multiple valid outlets all deactivated together', () => {
    const rows = parseDeactivateRows([
      { 'Outlet ID': 'OUT-001' },
      { 'Outlet ID': 'OUT-002' },
    ]);
    const result = validateDeactivateUpload(rows, ACTIVE_OUTLETS);
    expect(result.hasErrors).toBe(false);
    expect(result.summary.deactivates).toBe(2);
    expect(result.canProceed).toBe(true);
  });

  it('O53 — parseDeactivateRows assigns correct rowNum starting from 2', () => {
    const rows = parseDeactivateRows([
      { 'Outlet ID': 'OUT-001' },
      { 'Outlet ID': 'OUT-002' },
    ]);
    expect(rows[0].rowNum).toBe(2);
    expect(rows[1].rowNum).toBe(3);
    expect(rows[0].outletId).toBe('OUT-001');
  });
});

// ─── O54: M2 fix — outlet addition rejects underscore ────────────────────────

describe('outlet master — outlet ID underscore rejection (M2 fix)', () => {
  it('O54 — outlet ID with underscore is rejected (docs: "alphanumeric and hyphens only")', () => {
    const result = validateOutletUpload(
      [makeRow({ outletId: 'OUT_2026_001' })],
      [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /alphanumeric/i.test(e))).toBe(true);
  });
});

// ─── O57: H3 fix — re-KYC rejects NOT_STARTED outlet ────────────────────────

describe('re-KYC flag — rejects outlet with kycStatus=NOT_STARTED (H3 fix)', () => {
  it('O57 — outlet with kycStatus=NOT_STARTED is rejected (no prior KYC data)', () => {
    const row: ReKYCFlagRow = {
      rowNum: 2, outletId: 'OUT-NOT-STARTED',
      outletName:      '',
      ownerName:       'Yes', mobileNumber: '', gstNumber: '', panNumber: '',
      streetAddress:   '', city: '', pincode: '', state: '', bankName: '',
      accountHolderName: '',
      accountNumber:   '', ifscCode: '', upiId: '', gstCertificate: '',
      ownerPhoto:      '', addressProof: '', storeBoardPhoto: '',
      cancelledCheque: '', selfDeclaration: '', remarks: '',
    };
    const result = validateReKYCFlagUpload([row], EXISTING_OUTLETS);
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /not started|no kyc|pending/i.test(e))).toBe(true);
  });
});

// ─── O70–O78: Outlet master — UPDATE and REACTIVATE (upsert) ─────────────────

describe('outlet master — UPDATE existing active outlet', () => {
  it('O70 — existing active outlet ID → action UPDATE, status OK', () => {
    const result = validateOutletUpload(
      [makeRow({ outletId: 'OUT-ACTIVE-01', xsrId: 'ISR-M001' })],
      OUTLET_UPLOAD_EXISTING, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].action).toBe('UPDATE');
  });

  it('O71 — existing inactive outlet ID → action REACTIVATE, status OK', () => {
    const result = validateOutletUpload(
      [makeRow({ outletId: 'OUT-INACTIVE-01', xsrId: 'ISR-M001' })],
      OUTLET_UPLOAD_EXISTING, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].action).toBe('REACTIVATE');
  });

  it('O72 — UPDATE with blank XSR ID → OK (XSR change not required for updates)', () => {
    const result = validateOutletUpload(
      [makeRow({ outletId: 'OUT-ACTIVE-01', xsrId: '', outletName: '' })],
      OUTLET_UPLOAD_EXISTING, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].action).toBe('UPDATE');
  });

  it('O73 — UPDATE with valid leaf XSR ID → OK (re-tag via outlet master)', () => {
    const result = validateOutletUpload(
      [makeRow({ outletId: 'OUT-ACTIVE-01', xsrId: 'ISR-M001', outletName: '' })],
      OUTLET_UPLOAD_EXISTING, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].action).toBe('UPDATE');
  });

  it('O74 — UPDATE with XSR ID not in hierarchy → ERROR', () => {
    const result = validateOutletUpload(
      [makeRow({ outletId: 'OUT-ACTIVE-01', xsrId: 'GHOST-99', outletName: '' })],
      OUTLET_UPLOAD_EXISTING, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /not found/i.test(e))).toBe(true);
  });

  it('O75 — UPDATE with non-leaf XSR ID → ERROR', () => {
    const result = validateOutletUpload(
      [makeRow({ outletId: 'OUT-ACTIVE-01', xsrId: 'NSM-01', outletName: '' })],
      OUTLET_UPLOAD_EXISTING, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /leaf|XSR/i.test(e))).toBe(true);
  });

  it('O76 — UPDATE with outlet name provided → silently ignored (no error, action stays UPDATE)', () => {
    const result = validateOutletUpload(
      [makeRow({ outletId: 'OUT-ACTIVE-01', outletName: 'New Name Attempt', xsrId: 'ISR-M001' })],
      OUTLET_UPLOAD_EXISTING, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].action).toBe('UPDATE');
    expect(result.rows[0].errors).toHaveLength(0);
  });

  it('O77 — UPDATE with only outlet ID (all other fields blank) → ERROR: at least one field required', () => {
    const result = validateOutletUpload(
      [{
        rowNum: 2, outletId: 'OUT-ACTIVE-01', outletName: '',
        programName: '', programCategory: '', outletType: '',
        beat: '', distributorId: '', distributorName: '',
        metro: '', city: '', state: '', zone: '', xsrId: '',
      }],
      OUTLET_UPLOAD_EXISTING, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('ERROR');
    expect(result.rows[0].errors.some(e => /at least one/i.test(e))).toBe(true);
  });

  it('O78 — REACTIVATE with only outlet ID (all other fields blank) → OK (reactivation is the action)', () => {
    const result = validateOutletUpload(
      [{
        rowNum: 2, outletId: 'OUT-INACTIVE-01', outletName: '',
        programName: '', programCategory: '', outletType: '',
        beat: '', distributorId: '', distributorName: '',
        metro: '', city: '', state: '', zone: '', xsrId: '',
      }],
      OUTLET_UPLOAD_EXISTING, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].action).toBe('REACTIVATE');
  });
});

// ─── O79: Summary counts ──────────────────────────────────────────────────────

describe('outlet master — summary counts creates, updates, reactivates', () => {
  it('O79 — mixed upload: summary correctly counts each action type', () => {
    const rows = [
      makeRow({ outletId: 'OUT-NEW-1',     rowNum: 2 }),                               // CREATE
      makeRow({ outletId: 'OUT-ACTIVE-01', rowNum: 3, outletName: '' }),                // UPDATE
      makeRow({ outletId: 'OUT-INACTIVE-01', rowNum: 4, outletName: '' }),              // REACTIVATE
      makeRow({ outletId: 'OUT-NEW-2',     rowNum: 5 }),                               // CREATE
    ];
    const result = validateOutletUpload(rows, OUTLET_UPLOAD_EXISTING, VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE);
    expect(result.summary.creates).toBe(2);
    expect(result.summary.updates).toBe(1);
    expect(result.summary.reactivates).toBe(1);
    expect(result.summary.errors).toBe(0);
    expect(result.summary.total).toBe(4);
    expect(result.canProceed).toBe(true);
  });
});

// ─── O80–O81: Re-KYC — Outlet Name as flaggable field ────────────────────────

describe('re-KYC flag — Outlet Name as a flaggable field', () => {
  it('O80 — "Outlet Name" is present in REKYC_FIELD_KEYS and REKYC_FLAG_HEADERS', () => {
    expect(REKYC_FIELD_KEYS).toContain('Outlet Name');
    expect(REKYC_FLAG_HEADERS).toContain('Outlet Name');
  });

  it('O81 — row with only outletName flagged Yes → flagCount 1, status OK', () => {
    const row: ReKYCFlagRow = {
      rowNum:          2,
      outletId:        'OUT-2026-K01',
      outletName:      'Yes',
      ownerName:       '',
      mobileNumber:    '',
      gstNumber:       '',
      panNumber:       '',
      streetAddress:   '',
      city:            '',
      pincode:         '',
      state:           '',
      bankName:          '',
      accountHolderName: '',
      accountNumber:     '',
      ifscCode:          '',
      upiId:             '',
      gstCertificate:    '',
      ownerPhoto:        '',
      addressProof:      '',
      storeBoardPhoto:   '',
      cancelledCheque: '',
      selfDeclaration: '',
      remarks:         'Name correction needed',
    };
    const result = validateReKYCFlagUpload([row], EXISTING_OUTLETS);
    expect(result.rows[0].status).toBe('OK');
    expect(result.rows[0].flagCount).toBe(1);
  });
});

// ─── O82–O87: Zone column in outlet addition template ─────────────────────────
// TDD: Zone must be present in OUTLET_UPLOAD_HEADERS, parsed by parseOutletUploadRows,
//       carried through to the template helper, and treated as optional (blank is OK).

describe('O82–O87 — Zone column in outlet addition template', () => {
  it('O82 — OUTLET_UPLOAD_HEADERS contains "Zone"', () => {
    expect(OUTLET_UPLOAD_HEADERS).toContain('Zone');
  });

  it('O83 — "Zone" column appears after "State" in OUTLET_UPLOAD_HEADERS', () => {
    const headers = [...OUTLET_UPLOAD_HEADERS];
    const stateIdx = headers.indexOf('State');
    const zoneIdx  = headers.indexOf('Zone');
    expect(zoneIdx).toBeGreaterThan(stateIdx);
  });

  it('O84 — validateOutletUploadHeaders accepts headers that include Zone', () => {
    expect(validateOutletUploadHeaders(OUTLET_UPLOAD_HEADERS)).toBeNull();
  });

  it('O85 — parseOutletUploadRows reads Zone column into row.zone', () => {
    const raw = [{
      'Outlet ID': 'OUT-001', 'Outlet Name': 'Test Shop', 'Program Name': 'Trade Loyalty',
      'Program Category': 'Standard', 'Outlet Type': 'SSS', 'Beat': 'Andheri Beat',
      'Distributor ID': 'D1', 'Distributor Name': 'Dist 1', 'Metro': 'Yes',
      'City': 'Mumbai', 'State': 'Maharashtra', 'Zone': 'West Zone', 'XSR ID': 'ISR-M001',
    }];
    const rows = parseOutletUploadRows(raw);
    expect(rows[0].zone).toBe('West Zone');
  });

  it('O86 — parseOutletUploadRows sets zone to empty string when column is absent', () => {
    const raw = [{
      'Outlet ID': 'OUT-001', 'Outlet Name': 'Test Shop', 'Program Name': 'Trade Loyalty',
      'Program Category': 'Standard', 'Outlet Type': 'SSS', 'Beat': 'Andheri Beat',
      'Distributor ID': 'D1', 'Distributor Name': 'Dist 1', 'Metro': 'Yes',
      'City': 'Mumbai', 'State': 'Maharashtra', 'XSR ID': 'ISR-M001',
      // No 'Zone' key at all
    }];
    const rows = parseOutletUploadRows(raw);
    expect(rows[0].zone).toBe('');
  });

  it('O87 — getOutletAdditionTemplateData headers include "Zone"', () => {
    const { headers } = getOutletAdditionTemplateData(
      ['Trade Loyalty'],
      ['Standard'],
      'XSR',
    );
    expect(headers).toContain('Zone');
  });

  it('O88 — a row with blank Zone still passes validation (Zone is optional)', () => {
    const EXISTING: { outletId: string; isActive: boolean }[] = [];
    const row = {
      rowNum: 2, outletId: 'OUT-999', outletName: 'Blank Zone Shop',
      programName: 'Trade Loyalty', programCategory: 'Standard',
      outletType: 'SSS', beat: 'Test Beat', distributorId: '', distributorName: '',
      metro: 'Yes', city: 'Mumbai', state: 'Maharashtra',
      zone: '',   // intentionally blank
      xsrId: 'ISR-M001',
    };
    const result = validateOutletUpload(
      [row], EXISTING, ['Trade Loyalty'], ['Standard'], MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    expect(result.rows[0].status).toBe('OK');
  });
});
