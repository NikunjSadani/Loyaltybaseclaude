/**
 * TDD — RETAILER outlet type: internal key renamed from 'RETAILER' to 'SSS'
 *
 * AG1: OUTLET_TYPE_LABELS['SSS'] in targets.ts returns 'SSS'
 * AG2: OUTLET_TYPE_LABELS['SSS'] in partner-session.ts returns 'SSS'
 * AG3: OUTLET_TYPE_DESC['SSS'] in targets.ts does not mention 'retailer'
 * AG4: 'SSS' is a valid outlet type in upload validation (accepted, no error)
 * AG5: 'RETAILER' is no longer a valid outlet type in upload validation (rejected)
 */

import { describe, it, expect } from 'vitest';
import { OUTLET_TYPE_LABELS, OUTLET_TYPE_DESC } from '@/lib/targets';
import { OUTLET_TYPE_LABELS as PARTNER_OUTLET_TYPE_LABELS } from '@/lib/partner-session';
import { validateOutletUpload } from '@/lib/outlet-upload';
import type { HierarchyEmployee } from '@/types';

const VALID_PROGRAMS   = ['Trade Loyalty'];
const VALID_CATEGORIES = ['Standard'];
const MOCK_EMPLOYEES: HierarchyEmployee[] = [{
  id: 'EMP-001', tenantId: 't1', roleCode: 'XSR', roleLabel: 'ISR',
  reportsToId: null, hierarchyPath: '/EMP-001/', name: 'Test ISR',
  mobile: null, status: 'ACTIVE', hasOutlets: false, hasSubReports: false,
}];
const LEAF_ROLE_CODE = 'XSR';

function makeRow(overrides: Record<string, string>) {
  return {
    rowNum:          2,
    outletId:        'OUT-001',
    outletName:      'Test Outlet',
    outletType:      'SSS',
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

describe('AG — SSS internal key rename (was RETAILER)', () => {
  it('AG1: OUTLET_TYPE_LABELS["SSS"] in targets is "SSS"', () => {
    expect(OUTLET_TYPE_LABELS['SSS']).toBe('SSS');
  });

  it('AG2: OUTLET_TYPE_LABELS["SSS"] in partner-session is "SSS"', () => {
    expect(PARTNER_OUTLET_TYPE_LABELS['SSS']).toBe('SSS');
  });

  it('AG3: OUTLET_TYPE_DESC["SSS"] does not mention "retailer"', () => {
    expect(OUTLET_TYPE_DESC['SSS'].toLowerCase()).not.toContain('retailer');
  });

  it('AG4: "SSS" is accepted as a valid outlet type in upload validation', () => {
    const result = validateOutletUpload(
      [makeRow({ outletType: 'SSS' })],
      [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    const errors = result.rows.flatMap(r => r.errors ?? []);
    expect(errors.some(e => e.toLowerCase().includes('invalid') && e.includes('SSS'))).toBe(false);
  });

  // eslint-disable-next-line quotes
  it("AG5: 'RETAILER' is no longer a valid outlet type in upload validation", () => {
    const result = validateOutletUpload(
      [makeRow({ outletType: 'RETAILER' })],
      [], VALID_PROGRAMS, VALID_CATEGORIES, MOCK_EMPLOYEES, LEAF_ROLE_CODE,
    );
    const errors = result.rows.flatMap(r => r.errors ?? []);
    expect(errors.some(e => e.toLowerCase().includes('invalid'))).toBe(true);
  });
});
