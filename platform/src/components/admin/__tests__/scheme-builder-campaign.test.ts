/**
 * TDD tests for the enhanced SchemeBuilder campaign features.
 *
 * These tests cover the pure helper functions that will be extracted from
 * the SchemeBuilder component — campaign-type-driven validation, enhanced
 * Excel outlet parsing integration, and MSG91 notification config validation.
 *
 * Run:  npx vitest run src/components/admin/__tests__/scheme-builder-campaign.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  validateCampaignSchemeForm,
  buildEnhancedOutletTemplate,
  parseEnhancedOutletExcel,
  validateNotificationConfig,
  type SchemeBuilderCampaignForm,
} from '../scheme-builder-helpers';

// ─────────────────────────────────────────────────────────────────────────────
// validateCampaignSchemeForm
// ─────────────────────────────────────────────────────────────────────────────

describe('validateCampaignSchemeForm', () => {
  const base: SchemeBuilderCampaignForm = {
    name: 'Test Scheme',
    startDate: '2025-07-01',
    endDate: '2025-09-30',
    campaignType: 'LOYALTY_ONLY',
    applicableClasses: ['GOLD'],
    calculationMethod: 'FLAT',
    flatAmount: '500',
    holdingPeriodDays: '30',
    outletTargeting: 'ALL',
    targetedOutlets: [],
    requiresSelfRegistration: false,
    acceptDeadline: '',
    enrollmentFormFields: [],
    captureGpsOnSubmit: false,
    requireOtp: false,
    notificationConfig: null,
    budgetCap: '',
    requireApprovalGate: false,
    tags: [],
  };

  it('returns no errors for a valid LOYALTY_ONLY scheme', () => {
    expect(validateCampaignSchemeForm(base)).toEqual([]);
  });

  it('requires scheme name', () => {
    const errs = validateCampaignSchemeForm({ ...base, name: '' });
    expect(errs.some((e) => e.field === 'name')).toBe(true);
  });

  it('requires start date', () => {
    const errs = validateCampaignSchemeForm({ ...base, startDate: '' });
    expect(errs.some((e) => e.field === 'startDate')).toBe(true);
  });

  it('requires end date after start date', () => {
    const errs = validateCampaignSchemeForm({ ...base, endDate: '2025-06-30' });
    expect(errs.some((e) => e.field === 'endDate')).toBe(true);
  });

  it('requires at least one applicable class for LOYALTY_ONLY', () => {
    const errs = validateCampaignSchemeForm({ ...base, applicableClasses: [] });
    expect(errs.some((e) => e.field === 'applicableClasses')).toBe(true);
  });

  it('OPEN_CAMPAIGN does not require applicableClasses', () => {
    const errs = validateCampaignSchemeForm({
      ...base,
      campaignType: 'OPEN_CAMPAIGN',
      applicableClasses: [],
      enrollmentFormFields: [{ id: 'f1', label: 'Name', type: 'TEXT' }],
      requiresSelfRegistration: false,
    });
    expect(errs.some((e) => e.field === 'applicableClasses')).toBe(false);
  });

  it('OPEN_CAMPAIGN requires at least one enrollment form field', () => {
    const errs = validateCampaignSchemeForm({
      ...base,
      campaignType: 'OPEN_CAMPAIGN',
      applicableClasses: [],
      enrollmentFormFields: [],
    });
    expect(errs.some((e) => e.field === 'enrollmentFormFields')).toBe(true);
  });

  it('MIXED requires both applicableClasses AND enrollment form fields', () => {
    const noClass = validateCampaignSchemeForm({
      ...base,
      campaignType: 'MIXED',
      applicableClasses: [],
      enrollmentFormFields: [{ id: 'f1', label: 'Name', type: 'TEXT' }],
    });
    const noFields = validateCampaignSchemeForm({
      ...base,
      campaignType: 'MIXED',
      applicableClasses: ['GOLD'],
      enrollmentFormFields: [],
    });
    expect(noClass.some((e) => e.field === 'applicableClasses')).toBe(true);
    expect(noFields.some((e) => e.field === 'enrollmentFormFields')).toBe(true);
  });

  it('requires acceptDeadline when requiresSelfRegistration is true', () => {
    const errs = validateCampaignSchemeForm({
      ...base,
      requiresSelfRegistration: true,
      acceptDeadline: '',
    });
    expect(errs.some((e) => e.field === 'acceptDeadline')).toBe(true);
  });

  it('requires targetedOutlets when outletTargeting is SPECIFIC', () => {
    const errs = validateCampaignSchemeForm({
      ...base,
      outletTargeting: 'SPECIFIC',
      targetedOutlets: [],
    });
    expect(errs.some((e) => e.field === 'targetedOutlets')).toBe(true);
  });

  it('budgetCap must be a positive number when provided', () => {
    const negErr = validateCampaignSchemeForm({ ...base, budgetCap: '-100' });
    const zeroErr = validateCampaignSchemeForm({ ...base, budgetCap: '0' });
    const validOk = validateCampaignSchemeForm({ ...base, budgetCap: '50000' });
    expect(negErr.some((e) => e.field === 'budgetCap')).toBe(true);
    expect(zeroErr.some((e) => e.field === 'budgetCap')).toBe(true);
    expect(validOk.some((e) => e.field === 'budgetCap')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildEnhancedOutletTemplate
// ─────────────────────────────────────────────────────────────────────────────

describe('buildEnhancedOutletTemplate', () => {
  it('returns a Uint8Array (xlsx binary)', () => {
    const buf = buildEnhancedOutletTemplate([]);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('header row contains all standard columns', () => {
    const buf = buildEnhancedOutletTemplate([]);
    // We can verify by re-parsing
    const { utils, read } = require('xlsx') as typeof import('xlsx');
    const wb = read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][];
    const headers = rows[0];
    expect(headers).toContain('outlet_id');
    expect(headers).toContain('outlet_name');
    expect(headers).toContain('outlet_type');
    expect(headers).toContain('state');
    expect(headers).toContain('city');
    expect(headers).toContain('pincode');
    expect(headers).toContain('assigned_employee_id');
  });

  it('appends custom field columns when provided', () => {
    const buf = buildEnhancedOutletTemplate(['Shop Area (sqft)', 'Shop Photo URL']);
    const { utils, read } = require('xlsx') as typeof import('xlsx');
    const wb = read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = utils.sheet_to_json<string[]>(ws, { header: 1 }) as string[][];
    const headers = rows[0];
    expect(headers).toContain('Shop Area (sqft)');
    expect(headers).toContain('Shop Photo URL');
  });

  it('includes a sample KYC row and a sample non-KYC row', () => {
    const buf = buildEnhancedOutletTemplate([]);
    const { utils, read } = require('xlsx') as typeof import('xlsx');
    const wb = read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = utils.sheet_to_json<Record<string, string>>(ws, { defval: '' });
    // row 1 has an outlet_id
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // at least one row should have isKycEnrolled-like context (non-empty outlet_name means non-KYC example)
    const hasNonKyc = rows.some((r) => r['outlet_name'] && r['outlet_name'] !== '');
    expect(hasNonKyc).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseEnhancedOutletExcel
// ─────────────────────────────────────────────────────────────────────────────

describe('parseEnhancedOutletExcel', () => {
  const KYC_IDS = new Set(['KYC-001', 'KYC-002']);

  it('parses a valid KYC outlet row', () => {
    const result = parseEnhancedOutletExcel(
      [{ outlet_id: 'KYC-001', assigned_employee_id: 'EMP-1' }],
      KYC_IDS,
    );
    expect(result.outlets).toHaveLength(1);
    expect(result.outlets[0].isKycEnrolled).toBe(true);
    expect(result.outlets[0].assignedEmployeeId).toBe('EMP-1');
    expect(result.errors).toHaveLength(0);
  });

  it('parses a valid non-KYC outlet row', () => {
    const result = parseEnhancedOutletExcel(
      [{
        outlet_id: 'NON-001',
        outlet_name: 'New Shop',
        outlet_type: 'SSS',
        state: 'Maharashtra',
        city: 'Mumbai',
        assigned_employee_id: 'EMP-2',
      }],
      KYC_IDS,
    );
    expect(result.outlets).toHaveLength(1);
    expect(result.outlets[0].isKycEnrolled).toBe(false);
    expect(result.outlets[0].outletName).toBe('New Shop');
    expect(result.errors).toHaveLength(0);
  });

  it('returns an error for non-KYC outlet missing outlet_name', () => {
    const result = parseEnhancedOutletExcel(
      [{ outlet_id: 'NON-002', outlet_type: 'SSS', state: 'Delhi', city: 'New Delhi' }],
      KYC_IDS,
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/outlet_name/);
    expect(result.outlets).toHaveLength(0);
  });

  it('collects multiple row errors without stopping', () => {
    const result = parseEnhancedOutletExcel(
      [
        { outlet_id: 'NON-003', outlet_name: '', outlet_type: 'SSS', state: 'MH', city: 'Pune' },
        { outlet_id: 'NON-004', outlet_name: 'X', outlet_type: 'INVALID', state: 'MH', city: 'Pune' },
      ],
      KYC_IDS,
    );
    expect(result.errors).toHaveLength(2);
    expect(result.outlets).toHaveLength(0);
  });

  it('picks up extra columns as prefillValues', () => {
    const result = parseEnhancedOutletExcel(
      [{
        outlet_id: 'NON-005',
        outlet_name: 'Shop X',
        outlet_type: 'SSS',
        state: 'Delhi',
        city: 'New Delhi',
        'Shop Area': '300 sqft',
      }],
      KYC_IDS,
    );
    expect(result.outlets[0].prefillValues['Shop Area']).toBe('300 sqft');
  });

  it('deduplicates rows with the same outlet_id (last wins)', () => {
    const result = parseEnhancedOutletExcel(
      [
        { outlet_id: 'KYC-001', assigned_employee_id: 'EMP-A' },
        { outlet_id: 'KYC-001', assigned_employee_id: 'EMP-B' },
      ],
      KYC_IDS,
    );
    expect(result.outlets).toHaveLength(1);
    expect(result.outlets[0].assignedEmployeeId).toBe('EMP-B');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateNotificationConfig
// ─────────────────────────────────────────────────────────────────────────────

describe('validateNotificationConfig', () => {
  it('returns no errors for null config (notifications optional)', () => {
    expect(validateNotificationConfig(null)).toEqual([]);
  });

  it('returns no errors for a valid config with whatsappTemplateId', () => {
    const errs = validateNotificationConfig({
      whatsappTemplateId: 'tmpl_abc123',
      smsTemplateId: '',
      variableMapping: {},
      otpRequired: true,
    });
    expect(errs).toEqual([]);
  });

  it('requires at least whatsappTemplateId or smsTemplateId', () => {
    const errs = validateNotificationConfig({
      whatsappTemplateId: '',
      smsTemplateId: '',
      variableMapping: {},
      otpRequired: false,
    });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]).toMatch(/template/i);
  });

  it('returns no errors when only smsTemplateId is provided', () => {
    const errs = validateNotificationConfig({
      whatsappTemplateId: '',
      smsTemplateId: 'sms_xyz',
      variableMapping: {},
      otpRequired: false,
    });
    expect(errs).toEqual([]);
  });
});
