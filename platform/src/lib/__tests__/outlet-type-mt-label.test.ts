/**
 * TDD — MT outlet type: internal key renamed from 'MT' to 'SSS_TOT'
 *
 * AF1: OUTLET_TYPE_LABELS['SSS_TOT'] in targets.ts returns 'SSS TOT'
 * AF2: OUTLET_TYPE_LABELS['SSS_TOT'] in partner-session.ts returns 'SSS TOT'
 * AF3: OUTLET_TYPE_DESC['SSS_TOT'] in targets.ts does not mention 'modern trade'
 * AF4: 'SSS_TOT' is a valid outlet type in upload validation (accepted, no error)
 * AF5: 'MT' is no longer a valid outlet type in upload validation (rejected)
 */

import { describe, it, expect } from 'vitest';
import { OUTLET_TYPE_LABELS, OUTLET_TYPE_DESC } from '@/lib/targets';
import { OUTLET_TYPE_LABELS as PARTNER_OUTLET_TYPE_LABELS } from '@/lib/partner-session';
import { validateOutletUpload } from '@/lib/outlet-upload';

const VALID_PROGRAMS   = ['Trade Loyalty'];
const VALID_CATEGORIES = ['Standard'];
const MOCK_EMPLOYEES = [{
  id: 'EMP-001', tenantId: 't1', roleCode: 'XSR', roleLabel: 'ISR',
  reportsToId: null, hierarchyPath: '/EMP-001/', name: 'Test ISR',
  mobile: null, status: 'ACTIVE' as const, hasOutlets: false, hasSubReports: false,
}];
const LEAF_ROLE_CODE   = 'XSR';

function makeRow(overrides: Record<string, string>) {
  return {
    rowNum:          2,
    outletId:        '',
    outletName:      'Test Outlet',
    outletType:      'SSS_TOT',
    state:           'Maharashtra',
    city:            'Mumbai',
    programName:     'Trade Loyalty',
    programCategory: 'Standard',
    beat:            'Test Beat',
    distributorId:   '',
    distributorName: '',
    metro:           'Yes',
    zone:            '',
    xsrId:           'EMP-001',
    ...overrides,
  };
}

describe('AF — SSS_TOT internal key rename', () => {
  it('AF1: OUTLET_TYPE_LABELS["SSS_TOT"] in targets is "SSS TOT"', () => {
    expect(OUTLET_TYPE_LABELS['SSS_TOT']).toBe('SSS TOT');
  });

  it('AF2: OUTLET_TYPE_LABELS["SSS_TOT"] in partner-session is "SSS TOT"', () => {
    expect(PARTNER_OUTLET_TYPE_LABELS['SSS_TOT']).toBe('SSS TOT');
  });

  it('AF3: OUTLET_TYPE_DESC["SSS_TOT"] does not mention "modern trade"', () => {
    expect(OUTLET_TYPE_DESC['SSS_TOT'].toLowerCase()).not.toContain('modern trade');
  });

  it('AF4: "SSS_TOT" is accepted as a valid outlet type in upload validation', () => {
    const result = validateOutletUpload(
      [makeRow({ outletType: 'SSS_TOT' })],
      [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    const errors = result.rows.flatMap(r => r.errors ?? []);
    expect(errors.some(e => e.toLowerCase().includes('invalid') && e.includes('SSS_TOT'))).toBe(false);
  });

  it('AF5: "MT" is no longer a valid outlet type in upload validation', () => {
    const result = validateOutletUpload(
      [makeRow({ outletType: 'MT' })],
      [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    const errors = result.rows.flatMap(r => r.errors ?? []);
    expect(errors.some(e => e.toLowerCase().includes('invalid'))).toBe(true);
  });
});
