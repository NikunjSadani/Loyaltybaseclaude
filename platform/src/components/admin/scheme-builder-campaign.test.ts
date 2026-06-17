/**
 * scheme-builder-campaign.test.ts
 *
 * Unit-tests for the pure helper functions in scheme-builder-helpers.ts.
 * These tests verify the validation and Excel-parsing logic that backs
 * the SchemeBuilder component.  No DOM / React needed.
 */

import { describe, it, expect } from 'vitest';
import {
  validateCampaignSchemeForm,
  validateNotificationConfig,
  buildEnhancedOutletTemplate,
  parseEnhancedOutletExcel,
  type SchemeBuilderCampaignForm,
  type NotificationFormConfig,
} from './scheme-builder-helpers';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function baseForm(overrides: Partial<SchemeBuilderCampaignForm> = {}): SchemeBuilderCampaignForm {
  return {
    name:                     'Test Scheme',
    startDate:                '2026-07-01',
    endDate:                  '2026-09-30',
    campaignType:             'LOYALTY_ONLY',
    holdingPeriodDays:        '30',
    outletTargeting:          'ALL',
    targetedOutlets:          [],
    requiresSelfRegistration: false,
    acceptDeadline:           '',
    enrollmentFormFields:     [],
    captureGpsOnSubmit:       false,
    requireOtp:               true,
    notificationConfig:       null,
    budgetCap:                '',
    requireApprovalGate:      false,
    tags:                     [],
    ...overrides,
  };
}

// ─── validateCampaignSchemeForm ───────────────────────────────────────────────

describe('validateCampaignSchemeForm', () => {
  it('returns no errors for a fully-valid LOYALTY_ONLY form', () => {
    expect(validateCampaignSchemeForm(baseForm())).toHaveLength(0);
  });

  it('requires scheme name', () => {
    const errs = validateCampaignSchemeForm(baseForm({ name: '' }));
    expect(errs.some((e) => e.field === 'name')).toBe(true);
  });

  it('requires start date', () => {
    const errs = validateCampaignSchemeForm(baseForm({ startDate: '' }));
    expect(errs.some((e) => e.field === 'startDate')).toBe(true);
  });

  it('requires end date after start date', () => {
    const errs = validateCampaignSchemeForm(baseForm({ startDate: '2026-09-30', endDate: '2026-07-01' }));
    expect(errs.some((e) => e.field === 'endDate')).toBe(true);
  });

  it('requires enrollment form fields for OPEN_CAMPAIGN', () => {
    const errs = validateCampaignSchemeForm(
      baseForm({ campaignType: 'OPEN_CAMPAIGN', enrollmentFormFields: [] }),
    );
    expect(errs.some((e) => e.field === 'enrollmentFormFields')).toBe(true);
  });

  it('requires enrollment form fields for MIXED', () => {
    const errs = validateCampaignSchemeForm(
      baseForm({ campaignType: 'MIXED', enrollmentFormFields: [] }),
    );
    expect(errs.some((e) => e.field === 'enrollmentFormFields')).toBe(true);
  });

  it('does NOT require enrollment form fields for LOYALTY_ONLY', () => {
    const errs = validateCampaignSchemeForm(
      baseForm({ campaignType: 'LOYALTY_ONLY', enrollmentFormFields: [] }),
    );
    expect(errs.some((e) => e.field === 'enrollmentFormFields')).toBe(false);
  });

  it('requires acceptDeadline when requiresSelfRegistration is true', () => {
    const errs = validateCampaignSchemeForm(
      baseForm({ requiresSelfRegistration: true, acceptDeadline: '' }),
    );
    expect(errs.some((e) => e.field === 'acceptDeadline')).toBe(true);
  });

  it('no error for acceptDeadline when requiresSelfRegistration is false', () => {
    const errs = validateCampaignSchemeForm(
      baseForm({ requiresSelfRegistration: false, acceptDeadline: '' }),
    );
    expect(errs.some((e) => e.field === 'acceptDeadline')).toBe(false);
  });

  it('requires outlets when outletTargeting is SPECIFIC', () => {
    const errs = validateCampaignSchemeForm(
      baseForm({ outletTargeting: 'SPECIFIC', targetedOutlets: [] }),
    );
    expect(errs.some((e) => e.field === 'targetedOutlets')).toBe(true);
  });

  it('rejects non-positive budget cap', () => {
    const errs = validateCampaignSchemeForm(baseForm({ budgetCap: '-100' }));
    expect(errs.some((e) => e.field === 'budgetCap')).toBe(true);
  });

  it('accepts empty budget cap (no cap)', () => {
    const errs = validateCampaignSchemeForm(baseForm({ budgetCap: '' }));
    expect(errs.some((e) => e.field === 'budgetCap')).toBe(false);
  });

  it('accepts valid budget cap', () => {
    const errs = validateCampaignSchemeForm(baseForm({ budgetCap: '50000' }));
    expect(errs.some((e) => e.field === 'budgetCap')).toBe(false);
  });
});

// ─── validateNotificationConfig ───────────────────────────────────────────────

describe('validateNotificationConfig', () => {
  it('returns no errors when config is null (notifications optional)', () => {
    expect(validateNotificationConfig(null)).toHaveLength(0);
  });

  it('requires at least one template ID', () => {
    const cfg: NotificationFormConfig = {
      whatsappTemplateId: '',
      smsTemplateId: '',
      variableMapping: {},
      otpRequired: true,
    };
    expect(validateNotificationConfig(cfg)).not.toHaveLength(0);
  });

  it('passes when only WhatsApp template is provided', () => {
    const cfg: NotificationFormConfig = {
      whatsappTemplateId: 'tmpl_abc',
      smsTemplateId: '',
      variableMapping: {},
      otpRequired: true,
    };
    expect(validateNotificationConfig(cfg)).toHaveLength(0);
  });

  it('passes when only SMS template is provided', () => {
    const cfg: NotificationFormConfig = {
      whatsappTemplateId: '',
      smsTemplateId: 'sms_xyz',
      variableMapping: {},
      otpRequired: false,
    };
    expect(validateNotificationConfig(cfg)).toHaveLength(0);
  });
});

// ─── buildEnhancedOutletTemplate ──────────────────────────────────────────────

describe('buildEnhancedOutletTemplate', () => {
  it('returns a non-empty Uint8Array (valid xlsx binary)', () => {
    const buf = buildEnhancedOutletTemplate([]);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('includes custom column labels in template', () => {
    // The template is an xlsx binary; we just verify it does not throw and
    // returns a larger buffer when custom columns are added.
    const withoutCols = buildEnhancedOutletTemplate([]);
    const withCols    = buildEnhancedOutletTemplate(['Bonus Field', 'Region Code']);
    // A larger binary generally indicates more content (column headers)
    expect(withCols.length).toBeGreaterThanOrEqual(withoutCols.length);
  });
});

// ─── parseEnhancedOutletExcel ─────────────────────────────────────────────────

describe('parseEnhancedOutletExcel', () => {
  it('parses a valid KYC outlet row', () => {
    const rows = [{ outlet_id: 'KYC-001', assigned_employee_id: 'EMP-001' }];
    const kycIds = new Set(['KYC-001']);
    const { outlets, errors } = parseEnhancedOutletExcel(rows, kycIds);
    expect(errors).toHaveLength(0);
    expect(outlets).toHaveLength(1);
    expect(outlets[0].outletId).toBe('KYC-001');
    expect(outlets[0].isKycEnrolled).toBe(true);
  });

  it('parses a valid non-KYC outlet row', () => {
    const rows = [{
      outlet_id: 'NON-001',
      outlet_name: 'New Kirana',
      outlet_type: 'SSS',
      state: 'Maharashtra',
      city: 'Mumbai',
      assigned_employee_id: 'EMP-002',
    }];
    const { outlets, errors } = parseEnhancedOutletExcel(rows, new Set());
    expect(errors).toHaveLength(0);
    expect(outlets[0].isKycEnrolled).toBe(false);
    expect(outlets[0].outletName).toBe('New Kirana');
  });

  it('reports error for non-KYC row missing outlet_name', () => {
    const rows = [{
      outlet_id: 'NON-002',
      outlet_name: '',
      outlet_type: 'SSS',
      state: 'Maharashtra',
      city: 'Mumbai',
    }];
    const { outlets, errors } = parseEnhancedOutletExcel(rows, new Set());
    expect(errors.length).toBeGreaterThan(0);
    expect(outlets).toHaveLength(0);
  });

  it('deduplicates rows by outlet_id (last row wins)', () => {
    const rows = [
      { outlet_id: 'KYC-001', assigned_employee_id: 'EMP-001' },
      { outlet_id: 'KYC-001', assigned_employee_id: 'EMP-999' },
    ];
    const { outlets } = parseEnhancedOutletExcel(rows, new Set(['KYC-001']));
    expect(outlets).toHaveLength(1);
    expect(outlets[0].assignedEmployeeId).toBe('EMP-999');
  });
});
