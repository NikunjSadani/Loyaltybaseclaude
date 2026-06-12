/**
 * Pure helper functions for the enhanced SchemeBuilder.
 *
 * Kept separate from the React component so they can be unit-tested without
 * a DOM environment.
 */

import * as XLSX from 'xlsx';
import { parseOutletExcelRow, type OutletRecord } from '@/lib/campaign';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type CampaignType = 'LOYALTY_ONLY' | 'OPEN_CAMPAIGN' | 'MIXED';

export interface MinimalFormField {
  id: string;
  label: string;
  type: string;
}

export interface NotificationFormConfig {
  whatsappTemplateId: string;
  smsTemplateId: string;
  variableMapping: Record<string, string>;
  otpRequired: boolean;
}

export interface SchemeBuilderCampaignForm {
  // Basic
  name: string;
  startDate: string;
  endDate: string;
  // Campaign type
  campaignType: CampaignType;
  // Eligibility (used for LOYALTY_ONLY and MIXED)
  applicableClasses: string[];
  // Incentive
  calculationMethod: string;
  flatAmount: string;
  holdingPeriodDays: string;
  // Outlet targeting
  outletTargeting: 'ALL' | 'SPECIFIC';
  targetedOutlets: OutletRecord[];
  // Self-registration
  requiresSelfRegistration: boolean;
  acceptDeadline: string;
  // Enrollment form (used for OPEN_CAMPAIGN and MIXED)
  enrollmentFormFields: MinimalFormField[];
  captureGpsOnSubmit: boolean;
  requireOtp: boolean;
  // Notifications
  notificationConfig: NotificationFormConfig | null;
  // Advanced
  budgetCap: string;    // empty = no cap
  requireApprovalGate: boolean;
  tags: string[];
}

export interface ValidationError {
  field: string;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateCampaignSchemeForm
// ─────────────────────────────────────────────────────────────────────────────

export function validateCampaignSchemeForm(
  form: SchemeBuilderCampaignForm,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!form.name.trim()) {
    errors.push({ field: 'name', message: 'Scheme name is required.' });
  }

  if (!form.startDate) {
    errors.push({ field: 'startDate', message: 'Start date is required.' });
  }

  if (!form.endDate) {
    errors.push({ field: 'endDate', message: 'End date is required.' });
  } else if (form.startDate && form.endDate <= form.startDate) {
    errors.push({ field: 'endDate', message: 'End date must be after start date.' });
  }

  // LOYALTY_ONLY and MIXED need at least one partner class
  if (
    (form.campaignType === 'LOYALTY_ONLY' || form.campaignType === 'MIXED') &&
    form.applicableClasses.length === 0
  ) {
    errors.push({
      field: 'applicableClasses',
      message: 'Select at least one partner class.',
    });
  }

  // OPEN_CAMPAIGN and MIXED need at least one enrollment form field
  if (
    (form.campaignType === 'OPEN_CAMPAIGN' || form.campaignType === 'MIXED') &&
    form.enrollmentFormFields.length === 0
  ) {
    errors.push({
      field: 'enrollmentFormFields',
      message: 'Add at least one field to the enrollment form.',
    });
  }

  // Self-registration requires an accept deadline
  if (form.requiresSelfRegistration && !form.acceptDeadline) {
    errors.push({
      field: 'acceptDeadline',
      message: 'Accept-by date is required when self-registration is enabled.',
    });
  }

  // SPECIFIC targeting requires outlets
  if (form.outletTargeting === 'SPECIFIC' && form.targetedOutlets.length === 0) {
    errors.push({
      field: 'targetedOutlets',
      message: 'Upload an Excel file with outlet details.',
    });
  }

  // Budget cap must be positive if provided
  if (form.budgetCap !== '') {
    const cap = Number(form.budgetCap);
    if (isNaN(cap) || cap <= 0) {
      errors.push({
        field: 'budgetCap',
        message: 'Budget cap must be a positive number.',
      });
    }
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildEnhancedOutletTemplate
// ─────────────────────────────────────────────────────────────────────────────

const STANDARD_TEMPLATE_COLS = [
  'outlet_id',
  'outlet_name',
  'outlet_type',
  'state',
  'city',
  'pincode',
  'assigned_employee_id',
];

/**
 * Generates an xlsx binary for the multi-column outlet targeting template.
 * @param customFieldLabels  Labels of any auto-fill custom columns to include.
 */
export function buildEnhancedOutletTemplate(customFieldLabels: string[]): Uint8Array {
  const headers = [...STANDARD_TEMPLATE_COLS, ...customFieldLabels];

  // Example KYC row (outlet_name empty — resolved from system)
  const kycRow: Record<string, string> = {
    outlet_id: 'KYC-001',
    outlet_name: '',        // leave blank for KYC outlets
    outlet_type: '',
    state: '',
    city: '',
    pincode: '',
    assigned_employee_id: 'EMP-001',
  };

  // Example non-KYC row
  const nonKycRow: Record<string, string> = {
    outlet_id: 'NON-001',
    outlet_name: 'New Kirana Store',
    outlet_type: 'SSS',    // RETAILER | WHOLESALER | SUB_STOCKIST
    state: 'Maharashtra',
    city: 'Mumbai',
    pincode: '400001',
    assigned_employee_id: 'EMP-002',
  };

  // Fill custom columns with empty strings in sample rows
  for (const col of customFieldLabels) {
    kycRow[col] = '';
    nonKycRow[col] = 'sample value';
  }

  const ws = XLSX.utils.json_to_sheet([kycRow, nonKycRow], { header: headers });

  // Column widths
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(h.length + 4, 18) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Outlets');

  return new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as number[]);
}

// ─────────────────────────────────────────────────────────────────────────────
// parseEnhancedOutletExcel
// ─────────────────────────────────────────────────────────────────────────────

export interface ParseOutletResult {
  outlets: OutletRecord[];
  errors: string[];
}

/**
 * Parses all rows from an outlet-targeting Excel upload.
 * Deduplicates by outlet_id (last row wins).
 * Returns both valid outlets and per-row error messages.
 */
export function parseEnhancedOutletExcel(
  rows: Record<string, string>[],
  kycOutletIds: Set<string>,
): ParseOutletResult {
  const outlets: OutletRecord[] = [];
  const errors: string[] = [];

  // Use a map for deduplication; last row with same outlet_id overwrites earlier
  const outletMap = new Map<string, OutletRecord>();

  for (const row of rows) {
    const { outlet, error } = parseOutletExcelRow(row, kycOutletIds);
    if (error) {
      errors.push(error);
    } else if (outlet) {
      outletMap.set(outlet.outletId, outlet);
    }
  }

  for (const outlet of outletMap.values()) {
    outlets.push(outlet);
  }

  return { outlets, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// validateNotificationConfig
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a notification config.
 * Returns empty array if config is null (notifications are optional).
 */
export function validateNotificationConfig(
  config: NotificationFormConfig | null,
): string[] {
  if (config === null) return [];

  const errors: string[] = [];

  if (!config.whatsappTemplateId.trim() && !config.smsTemplateId.trim()) {
    errors.push('At least one template ID (WhatsApp or SMS) is required.');
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// downloadEnhancedTemplate  (side-effectful — calls XLSX.writeFile in browser)
// ─────────────────────────────────────────────────────────────────────────────

export function downloadEnhancedTemplate(customFieldLabels: string[]): void {
  const buf = buildEnhancedOutletTemplate(customFieldLabels);
  const blob = new Blob([buf.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'outlet_targeting_template.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}
