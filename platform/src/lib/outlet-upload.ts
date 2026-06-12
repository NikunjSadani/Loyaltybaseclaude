/**
 * outlet-upload.ts
 *
 * Pure-logic library for all three outlet bulk-upload flows:
 *   1. Outlet Addition   — admin creates new outlets (PENDING / isActive=false)
 *   2. Outlet Re-tagging — admin reassigns outlets to a different XSR
 *   3. Re-KYC Flagging   — admin marks which KYC fields must be re-captured
 *
 * No side-effects, no browser APIs — safe to import in tests and server code.
 */

import type {
  OutletUploadRow,
  OutletUploadRowResult,
  OutletUploadValidationResult,
  ReKYCFlagRow,
  ReKYCFlagRowResult,
  ReKYCFlagValidationResult,
  OutletRecord,
  ReKYCFlags,
  OutletDeactivateRow,
  OutletDeactivateRowResult,
  OutletDeactivateValidationResult,
} from '@/types';
import type { HierarchyEmployee, TenantHierarchyLevel } from '@/types';
import { KYCStatus } from '@/types';

// ─── Constants ────────────────────────────────────────────────────────────────

export const OUTLET_UPLOAD_HEADERS = [
  'Outlet ID',
  'Outlet Name',
  'Program Name',
  'Program Category',
  'Outlet Type',
  'Beat',
  'Distributor ID',
  'Distributor Name',
  'Metro',
  'City',
  'State',
  'Zone',
  'XSR ID',
] as const;

/**
 * All KYC field column names in the Re-KYC flag template.
 * Order matters — it mirrors the KYC form's visual flow.
 * 'Outlet Name' is first because outlet name corrections must go through
 * the KYC approval chain (cannot be edited directly via Outlet Master upload).
 */
export const REKYC_FIELD_KEYS = [
  'Outlet Name',
  'Owner / Contact Name',
  'Mobile Number',
  'GST Number',
  'PAN Number',
  'Street Address',
  'City',
  'Pincode',
  'State',
  'Bank Name',
  'Account Holder Name',
  'Account Number',
  'IFSC Code',
  'UPI ID',
  'GST Certificate (Document)',
  'Owner Photo (Document)',
  'Address Proof (Document)',
  'Store Board Photo (Document)',
  'Cancelled Cheque (Document)',
  'Self Declaration (Document)',
] as const;

export const REKYC_FLAG_HEADERS = [
  'Outlet ID',
  ...REKYC_FIELD_KEYS,
  'Remarks',
] as const;

/** Mapping from REKYC_FIELD_KEYS to ReKYCFlags property names */
const REKYC_KEY_TO_FLAG: Record<string, keyof Omit<ReKYCFlags, 'remarks'>> = {
  'Outlet Name':                    'outletName',
  'Owner / Contact Name':          'ownerName',
  'Mobile Number':                  'mobileNumber',
  'GST Number':                     'gstNumber',
  'PAN Number':                     'panNumber',
  'Street Address':                 'streetAddress',
  'City':                           'city',
  'Pincode':                        'pincode',
  'State':                          'state',
  'Bank Name':                      'bankName',
  'Account Holder Name':            'accountHolderName',
  'Account Number':                 'accountNumber',
  'IFSC Code':                      'ifscCode',
  'UPI ID':                         'upiId',
  'GST Certificate (Document)':     'gstCertificate',
  'Owner Photo (Document)':         'ownerPhoto',
  'Address Proof (Document)':       'addressProof',
  'Store Board Photo (Document)':   'storeBoardPhoto',
  'Cancelled Cheque (Document)':    'cancelledCheque',
  'Self Declaration (Document)':    'selfDeclaration',
};

const VALID_OUTLET_TYPES = new Set(['SSS', 'WHOLESALER', 'SUB_STOCKIST', 'SSS_TOT']);

// ─── Utility helpers ──────────────────────────────────────────────────────────

/** "Yes" / "YES" / "yes" → true. Everything else → false. */
export function isYes(val: string): boolean {
  return val.trim().toLowerCase() === 'yes';
}

/** Is a row completely blank (all fields empty)? */
function isBlankOutletRow(row: OutletUploadRow): boolean {
  return (
    !row.outletId.trim() &&
    !row.outletName.trim() &&
    !row.programName.trim() &&
    !row.programCategory.trim() &&
    !row.outletType.trim() &&
    !row.beat.trim() &&
    !row.city.trim() &&
    !row.state.trim() &&
    !row.xsrId.trim()
  );
}

// ─── Header validators ────────────────────────────────────────────────────────

export function validateOutletUploadHeaders(headers: readonly string[]): string | null {
  const missing = (OUTLET_UPLOAD_HEADERS as readonly string[]).filter(h => !headers.includes(h));
  if (missing.length === 0) return null;
  return `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;
}

export function validateReKYCFlagHeaders(headers: readonly string[]): string | null {
  const missing = (REKYC_FLAG_HEADERS as readonly string[]).filter(h => !headers.includes(h));
  if (missing.length === 0) return null;
  return `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;
}

// ─── Row parsers ──────────────────────────────────────────────────────────────

export function parseOutletUploadRows(rawRows: Record<string, string>[]): OutletUploadRow[] {
  return rawRows.map((raw, idx) => ({
    rowNum:          idx + 2,  // row 1 = header
    outletId:        (raw['Outlet ID']         ?? '').trim(),
    outletName:      (raw['Outlet Name']        ?? '').trim(),
    programName:     (raw['Program Name']       ?? '').trim(),
    programCategory: (raw['Program Category']   ?? '').trim(),
    outletType:      (raw['Outlet Type']        ?? '').trim(),
    beat:            (raw['Beat']               ?? '').trim(),
    distributorId:   (raw['Distributor ID']     ?? '').trim(),
    distributorName: (raw['Distributor Name']   ?? '').trim(),
    metro:           (raw['Metro']              ?? '').trim(),
    city:            (raw['City']               ?? '').trim(),
    state:           (raw['State']              ?? '').trim(),
    zone:            (raw['Zone']               ?? '').trim(),
    xsrId:           (raw['XSR ID']             ?? '').trim(),
  }));
}

export function parseReKYCFlagRows(rawRows: Record<string, string>[]): ReKYCFlagRow[] {
  return rawRows.map((raw, idx) => ({
    rowNum:          idx + 2,
    outletId:        (raw['Outlet ID']                    ?? '').trim(),
    outletName:      (raw['Outlet Name']                  ?? '').trim(),
    ownerName:       (raw['Owner / Contact Name']          ?? '').trim(),
    mobileNumber:    (raw['Mobile Number']                 ?? '').trim(),
    gstNumber:       (raw['GST Number']                    ?? '').trim(),
    panNumber:       (raw['PAN Number']                    ?? '').trim(),
    streetAddress:   (raw['Street Address']                ?? '').trim(),
    city:            (raw['City']                          ?? '').trim(),
    pincode:         (raw['Pincode']                       ?? '').trim(),
    state:           (raw['State']                         ?? '').trim(),
    bankName:          (raw['Bank Name']                   ?? '').trim(),
    accountHolderName: (raw['Account Holder Name']         ?? '').trim(),
    accountNumber:     (raw['Account Number']              ?? '').trim(),
    ifscCode:        (raw['IFSC Code']                     ?? '').trim(),
    upiId:           (raw['UPI ID']                        ?? '').trim(),
    gstCertificate:  (raw['GST Certificate (Document)']    ?? '').trim(),
    ownerPhoto:      (raw['Owner Photo (Document)']        ?? '').trim(),
    addressProof:    (raw['Address Proof (Document)']      ?? '').trim(),
    storeBoardPhoto: (raw['Store Board Photo (Document)']  ?? '').trim(),
    cancelledCheque: (raw['Cancelled Cheque (Document)']   ?? '').trim(),
    selfDeclaration: (raw['Self Declaration (Document)']   ?? '').trim(),
    remarks:         (raw['Remarks']                       ?? '').trim(),
  }));
}

// ─── Outlet Addition Validation ───────────────────────────────────────────────

export function validateOutletUpload(
  rows:              OutletUploadRow[],
  existingOutlets:   Pick<OutletRecord, 'outletId' | 'isActive'>[],
  validPrograms:     string[],
  validCategories:   string[],
  employees:         HierarchyEmployee[],
  leafRoleCode:      string,
): OutletUploadValidationResult {
  const existingMap  = new Map(existingOutlets.map(o => [o.outletId, o]));
  const seenInUpload = new Map<string, number>(); // outletId → first rowNum
  const empById      = new Map(employees.map(e => [e.id, e]));

  const rowResults: OutletUploadRowResult[] = [];

  for (const row of rows) {
    // Skip blank rows silently
    if (isBlankOutletRow(row)) continue;

    const errors: string[] = [];

    // Determine action: CREATE, UPDATE (existing active), or REACTIVATE (existing inactive)
    const existingRecord = row.outletId ? existingMap.get(row.outletId) : undefined;
    let action: 'CREATE' | 'UPDATE' | 'REACTIVATE' = 'CREATE';
    if (existingRecord) {
      action = existingRecord.isActive ? 'UPDATE' : 'REACTIVATE';
    }

    // 1. Outlet ID required
    if (!row.outletId) {
      errors.push('Outlet ID is required');
    } else {
      // 2. Outlet ID format: alphanumeric and hyphens only (no underscores — template Dos & Don'ts)
      if (!/^[A-Za-z0-9-]+$/.test(row.outletId)) {
        errors.push(`Outlet ID "${row.outletId}" contains invalid characters — only alphanumeric characters and hyphens are allowed`);
      }

      // 3. Duplicate within upload
      if (seenInUpload.has(row.outletId)) {
        errors.push(`Duplicate Outlet ID "${row.outletId}" — first seen at row ${seenInUpload.get(row.outletId)}`);
      } else {
        seenInUpload.set(row.outletId, row.rowNum);
      }
    }

    if (action === 'CREATE') {
      // ── Full validation for new outlets ──────────────────────────────

      // 4. Outlet Name required (cannot be edited via this upload for existing outlets)
      if (!row.outletName) {
        errors.push('Outlet Name is required');
      }

      // 5. Program Name must be in configured list
      if (!row.programName) {
        errors.push('Program Name is required');
      } else if (!validPrograms.includes(row.programName)) {
        errors.push(`Program Name "${row.programName}" is not in the configured list. Valid values: ${validPrograms.join(', ')}`);
      }

      // 6. Program Category must be in configured list
      if (!row.programCategory) {
        errors.push('Program Category is required');
      } else if (!validCategories.includes(row.programCategory)) {
        errors.push(`Program Category "${row.programCategory}" is not in the configured list. Valid values: ${validCategories.join(', ')}`);
      }

      // 7. Outlet Type must be valid enum
      if (!row.outletType) {
        errors.push('Outlet Type is required');
      } else if (!VALID_OUTLET_TYPES.has(row.outletType.toUpperCase())) {
        errors.push(`Outlet Type "${row.outletType}" is invalid — must be one of: SSS, WHOLESALER, SUB_STOCKIST, SSS_TOT`);
      }

      // 8. Beat required
      if (!row.beat) {
        errors.push('Beat is required');
      }

      // 9. Metro must be Yes or No
      if (!row.metro) {
        errors.push('Metro is required — enter "Yes" or "No"');
      } else if (!['yes', 'no'].includes(row.metro.toLowerCase())) {
        errors.push(`Metro "${row.metro}" is invalid — must be "Yes" or "No"`);
      }

      // 10. City required
      if (!row.city) {
        errors.push('City is required');
      }

      // 11. State required
      if (!row.state) {
        errors.push('State is required');
      }

      // 12. XSR ID required for new outlets
      if (!row.xsrId) {
        errors.push('XSR ID is required');
      } else {
        const emp = empById.get(row.xsrId);
        if (!emp) {
          errors.push(`XSR ID "${row.xsrId}" not found in the employee hierarchy. Add the employee via Employee Hierarchy upload first.`);
        } else if (emp.roleCode !== leafRoleCode) {
          errors.push(`XSR ID "${row.xsrId}" has role "${emp.roleCode}" — only ${leafRoleCode} (field-level) employees can be assigned outlets`);
        }
      }

    } else {
      // ── Partial validation for UPDATE / REACTIVATE ───────────────────
      // Outlet Name is silently ignored (cannot be edited via master upload).
      // Only provided (non-blank) fields are validated.
      // For UPDATE: at least one updatable field must be provided.
      // For REACTIVATE: no minimum field requirement (reactivation itself is the action).

      if (action === 'UPDATE') {
        const hasAnyUpdatableField = !!(
          row.programName || row.programCategory || row.outletType ||
          row.beat        || row.distributorId   || row.distributorName ||
          row.metro       || row.city            || row.state || row.xsrId
        );
        if (!hasAnyUpdatableField) {
          errors.push('At least one field must be provided for an update — only the Outlet ID was supplied');
        }
      }

      // Validate any provided fields
      if (row.programName && !validPrograms.includes(row.programName)) {
        errors.push(`Program Name "${row.programName}" is not in the configured list. Valid values: ${validPrograms.join(', ')}`);
      }

      if (row.programCategory && !validCategories.includes(row.programCategory)) {
        errors.push(`Program Category "${row.programCategory}" is not in the configured list. Valid values: ${validCategories.join(', ')}`);
      }

      if (row.outletType && !VALID_OUTLET_TYPES.has(row.outletType.toUpperCase())) {
        errors.push(`Outlet Type "${row.outletType}" is invalid — must be one of: SSS, WHOLESALER, SUB_STOCKIST, SSS_TOT`);
      }

      if (row.metro && !['yes', 'no'].includes(row.metro.toLowerCase())) {
        errors.push(`Metro "${row.metro}" is invalid — must be "Yes" or "No"`);
      }

      // XSR ID optional for updates/reactivations; if provided must be valid + leaf
      if (row.xsrId) {
        const emp = empById.get(row.xsrId);
        if (!emp) {
          errors.push(`XSR ID "${row.xsrId}" not found in the employee hierarchy. Add the employee via Employee Hierarchy upload first.`);
        } else if (emp.roleCode !== leafRoleCode) {
          errors.push(`XSR ID "${row.xsrId}" has role "${emp.roleCode}" — only ${leafRoleCode} (field-level) employees can be assigned outlets`);
        }
      }
    }

    rowResults.push({
      rowNum:   row.rowNum,
      outletId: row.outletId,
      status:   errors.length > 0 ? 'ERROR' : 'OK',
      errors,
      action,
    });
  }

  const hasErrors   = rowResults.some(r => r.status === 'ERROR');
  const creates     = rowResults.filter(r => r.status === 'OK' && r.action === 'CREATE').length;
  const updates     = rowResults.filter(r => r.status === 'OK' && r.action === 'UPDATE').length;
  const reactivates = rowResults.filter(r => r.status === 'OK' && r.action === 'REACTIVATE').length;

  return {
    headerError: null,
    rows:        rowResults,
    hasErrors,
    canProceed:  !hasErrors && rowResults.length > 0,
    summary:     {
      total: rowResults.length,
      creates,
      updates,
      reactivates,
      errors: rowResults.filter(r => r.status === 'ERROR').length,
    },
  };
}

// ─── Re-KYC Flag Validation ───────────────────────────────────────────────────

export function validateReKYCFlagUpload(
  rows:            ReKYCFlagRow[],
  existingOutlets: Pick<OutletRecord, 'outletId' | 'kycStatus'>[],
): ReKYCFlagValidationResult {
  const existingMap  = new Map(existingOutlets.map(o => [o.outletId, o]));
  const seenInUpload = new Map<string, number>();

  const rowResults: ReKYCFlagRowResult[] = [];

  for (const row of rows) {
    const errors: string[] = [];

    // 1. Outlet ID required
    if (!row.outletId) {
      errors.push('Outlet ID is required');
    } else {
      // 2. Must exist in system (and not be NOT_STARTED — H3)
      const existing = existingMap.get(row.outletId);
      if (!existing) {
        errors.push(`Outlet ID "${row.outletId}" not found in the system`);
      } else if (existing.kycStatus === KYCStatus.NOT_STARTED) {
        errors.push(`Outlet "${row.outletId}" has no KYC data yet (status: NOT_STARTED) — re-KYC flagging requires at least one completed KYC submission`);
      }
      // 3. No duplicate outlet ID
      if (seenInUpload.has(row.outletId)) {
        errors.push(`Duplicate Outlet ID "${row.outletId}" — first seen at row ${seenInUpload.get(row.outletId)}`);
      } else {
        seenInUpload.set(row.outletId, row.rowNum);
      }
    }

    // Count "Yes" flags
    const flagCount = (REKYC_FIELD_KEYS as readonly string[]).reduce((n, key) => {
      const propKey = REKYC_KEY_TO_FLAG[key] ?? key;
      const rowVal  = (row as unknown as Record<string, string>)[propKey];
      return n + (isYes(rowVal ?? '') ? 1 : 0);
    }, 0);

    // 4. At least one field must be flagged
    if (flagCount === 0) {
      errors.push('At least one field must be marked "Yes" for re-KYC to be triggered');
    }

    rowResults.push({
      rowNum:    row.rowNum,
      outletId:  row.outletId,
      status:    errors.length > 0 ? 'ERROR' : 'OK',
      errors,
      flagCount,
    });
  }

  const hasErrors = rowResults.some(r => r.status === 'ERROR');
  const flagged   = rowResults.filter(r => r.status === 'OK').length;

  return {
    headerError: null,
    rows:        rowResults,
    hasErrors,
    canProceed:  !hasErrors && rowResults.length > 0,
    summary:     { total: rowResults.length, flagged, errors: rowResults.filter(r => r.status === 'ERROR').length },
  };
}

// ─── Convert ReKYCFlagRow to ReKYCFlags ───────────────────────────────────────

export function toReKYCFlags(row: ReKYCFlagRow): ReKYCFlags {
  return {
    outletName:      isYes(row.outletName),
    ownerName:       isYes(row.ownerName),
    mobileNumber:    isYes(row.mobileNumber),
    gstNumber:       isYes(row.gstNumber),
    panNumber:       isYes(row.panNumber),
    streetAddress:   isYes(row.streetAddress),
    city:            isYes(row.city),
    pincode:         isYes(row.pincode),
    state:           isYes(row.state),
    bankName:          isYes(row.bankName),
    accountHolderName: isYes(row.accountHolderName),
    accountNumber:     isYes(row.accountNumber),
    ifscCode:        isYes(row.ifscCode),
    upiId:           isYes(row.upiId),
    gstCertificate:  isYes(row.gstCertificate),
    ownerPhoto:      isYes(row.ownerPhoto),
    addressProof:    isYes(row.addressProof),
    storeBoardPhoto: isYes(row.storeBoardPhoto),
    cancelledCheque: isYes(row.cancelledCheque),
    selfDeclaration: isYes(row.selfDeclaration),
    remarks:         row.remarks,
  };
}

// ─── Template data ────────────────────────────────────────────────────────────

export interface OutletTemplateData {
  headers:      string[];
  exampleRows:  string[][];
  dosAndDonts:  string[][];
}

export function getOutletAdditionTemplateData(
  validPrograms:    string[],
  validCategories:  string[],
  leafRoleCode:     string,
): OutletTemplateData {
  const headers = [...OUTLET_UPLOAD_HEADERS];

  const exampleRows: string[][] = [
    ['OUT-2026-001', 'Verma Traders', validPrograms[0] ?? 'Trade Loyalty', validCategories[0] ?? 'Standard', 'SSS',        'Andheri Beat',  'DIST-01', 'ABC Distributors', 'Yes', 'Mumbai', 'Maharashtra', 'West Zone',   `${leafRoleCode}-M001`],
    ['OUT-2026-002', 'Patel Kirana',  validPrograms[0] ?? 'Trade Loyalty', validCategories[1] ?? 'Premium',  'WHOLESALER', 'Borivali Beat', 'DIST-02', 'XYZ Distributors', 'No',  'Pune',   'Maharashtra', '',            `${leafRoleCode}-P001`],
  ];

  const dosAndDonts: string[][] = [
    ['OUTLET ADDITION — Dos & Don\'ts', ''],
    ['', ''],
    ['COLUMN REFERENCE', ''],
    ['Outlet ID',         'Unique outlet code you assign — e.g. OUT-2026-001. Alphanumeric and hyphens only. Once created, this ID cannot be changed via upload.'],
    ['Outlet Name',       'Shop/store name as it appears on the board'],
    ['Program Name',      `Must be one of: ${validPrograms.join(', ')}`],
    ['Program Category',  `Must be one of: ${validCategories.join(', ')}`],
    ['Outlet Type',       'Must be exactly: SSS, WHOLESALER, SUB_STOCKIST, or SSS_TOT'],
    ['Beat',              'Beat/area name this outlet belongs to'],
    ['Distributor ID',    'Reference only — enter distributor code if known, or leave blank'],
    ['Distributor Name',  'Reference only — distributor\'s business name, or leave blank'],
    ['Metro',             'Is this outlet in a metro city? Enter Yes or No only'],
    ['City',              'City where the outlet is located'],
    ['State',             'State where the outlet is located'],
    ['Zone',              'Geographic sales zone this outlet belongs to (e.g. "West Zone", "North Zone"). Leave blank if not applicable.'],
    ['XSR ID',            `Employee ID of the ${leafRoleCode} (field sales rep) this outlet is assigned to. Must exist in the Employee Hierarchy.`],
    ['', ''],
    ['✓ DOs', ''],
    ['DO',  'Use the exact Outlet ID format — alphanumeric and hyphens only'],
    ['DO',  'Ensure the XSR ID exists in the Employee Hierarchy before uploading'],
    ['DO',  'Enter exactly "Yes" or "No" (without quotes) for the Metro column'],
    ['DO',  'Use the exact Program Name and Program Category values from the configured list'],
    ['DO',  'Keep Outlet IDs unique — this system does not allow editing via this upload'],
    ['', ''],
    ['✗ DON\'Ts', ''],
    ['DON\'T', 'Re-upload an existing Outlet ID — it will be rejected. This upload is for new outlets only.'],
    ['DON\'T', 'Enter an XSR ID that belongs to a non-field role (SO, ASM, RSM, ZNM, NSM) — only ISR-level IDs are accepted'],
    ['DON\'T', 'Leave Outlet ID, Outlet Name, Program Name, Program Category, Outlet Type, Beat, Metro, City, State, or XSR ID blank'],
    ['DON\'T', 'Use spaces or special characters in Outlet ID'],
    ['', ''],
    ['COMMON MISTAKES', ''],
    ['MISTAKE', 'Using a SO/ASM ID in the XSR ID column — only leaf-level (ISR) IDs are accepted'],
    ['MISTAKE', 'Entering "Yes " (with trailing space) in Metro — trim all spaces'],
    ['MISTAKE', 'Uploading the same Outlet ID twice in one file — both rows will be marked as errors'],
    ['MISTAKE', 'Program Name or Category that doesn\'t exactly match the configured list (case-sensitive)'],
  ];

  return { headers, exampleRows, dosAndDonts };
}

export function getReKYCFlagTemplateData(): OutletTemplateData {
  const headers = [...REKYC_FLAG_HEADERS];

  const exampleRow: string[] = [
    'OUT-2026-001',
    '',     // Outlet Name
    'Yes',  // Owner / Contact Name
    '',     // Mobile Number
    '',     // GST Number
    '',     // PAN Number
    '',     // Street Address
    '',     // City
    '',     // Pincode
    '',     // State
    '',     // Bank Name
    '',     // Account Number
    '',     // IFSC Code
    '',     // UPI ID
    '',     // GST Certificate (Document)
    'Yes',  // Owner Photo (Document)
    '',     // Address Proof (Document)
    '',     // Store Board Photo (Document)
    '',     // Cancelled Cheque (Document)
    '',     // Self Declaration (Document)
    'Owner moved shop — re-capture name and photo',
  ];

  const dosAndDonts: string[][] = [
    ['RE-KYC FLAGGING — Dos & Don\'ts', ''],
    ['', ''],
    ['WHAT THIS DOES', ''],
    ['IMPORTANT', 'This upload does NOT change any KYC data. It flags which fields the sales team must re-capture. The ISR/SO will see a "Re-KYC Required" badge on the outlet and must re-fill the flagged fields via the normal KYC form.'],
    ['', ''],
    ['COLUMN REFERENCE', ''],
    ['Outlet ID', 'The outlet whose KYC needs refreshing — must exist in the system'],
    ['Each field column', 'Enter "Yes" to flag that field for re-capture. Leave blank to keep existing data.'],
    ['Remarks', 'Optional note to the sales team explaining why re-KYC is needed'],
    ['', ''],
    ['FIELD TYPE GUIDE', ''],
    ['Text fields', 'Owner Name, Mobile, GST, PAN, Address, City, Pincode, State, Bank details, UPI — sales team re-types these'],
    ['Document fields (marked "Document")', 'Sales team must re-upload the actual file/photo via the KYC form'],
    ['', ''],
    ['✓ DOs', ''],
    ['DO', 'Enter "Yes" (exactly) in the columns that need to be refreshed'],
    ['DO', 'Add a clear note in the Remarks column so the sales team understands what to re-capture and why'],
    ['DO', 'Flag the minimum necessary fields — unflagged fields retain their current values'],
    ['', ''],
    ['✗ DON\'Ts', ''],
    ['DON\'T', 'Leave all field columns blank — at least one must be "Yes" or the row is rejected'],
    ['DON\'T', 'Enter "No" explicitly — just leave the column blank for fields that don\'t need updating'],
    ['DON\'T', 'Upload an Outlet ID that does not exist in the system'],
    ['DON\'T', 'Expect this upload to immediately update any data — it only triggers the re-capture workflow'],
    ['', ''],
    ['COMMON MISTAKES', ''],
    ['MISTAKE', 'Marking "Yes" in a document column expecting to paste a file — documents must be re-uploaded via the KYC form by the ISR/SO on ground'],
    ['MISTAKE', 'Uploading the same outlet twice in one file'],
  ];

  return { headers, exampleRows: [exampleRow], dosAndDonts };
}

// ─── Outlet Deactivation ──────────────────────────────────────────────────────

export const DEACTIVATE_HEADERS = ['Outlet ID'] as const;

/** Validate that the upload has exactly the required header. */
export function validateDeactivateHeaders(headers: readonly string[]): string | null {
  const missing = (DEACTIVATE_HEADERS as readonly string[]).filter(h => !headers.includes(h));
  return missing.length > 0
    ? `Missing required column(s): ${missing.join(', ')}`
    : null;
}

/** Regex for a valid outlet ID — alphanumeric and hyphens only, at least 1 char. */
const OUTLET_ID_RE = /^[A-Za-z0-9-]+$/;

/**
 * Parse raw XLSX rows (each row is a Record<string, string>) into typed
 * OutletDeactivateRow objects, skipping blank rows.
 * Row numbers start at 2 (row 1 = header).
 */
export function parseDeactivateRows(
  raw: Record<string, string>[],
): OutletDeactivateRow[] {
  const result: OutletDeactivateRow[] = [];
  raw.forEach((r, idx) => {
    const outletId = (r['Outlet ID'] ?? '').trim();
    if (!outletId) return; // skip blank rows silently
    result.push({ rowNum: idx + 2, outletId });
  });
  return result;
}

/**
 * Validate all deactivation rows in one pass.
 * Rules:
 *   1. Outlet ID must pass the regex (alphanumeric + hyphens).
 *   2. Outlet must exist in the system.
 *   3. Outlet must currently be active (isActive = true).
 *   4. No duplicate Outlet ID within the upload.
 */
export function validateDeactivateUpload(
  rows:    OutletDeactivateRow[],
  outlets: Array<{ outletId: string; isActive: boolean }>,
): OutletDeactivateValidationResult {
  const outletMap = new Map(outlets.map(o => [o.outletId, o]));
  const seenInUpload = new Map<string, number>(); // outletId → first rowNum
  const rowResults: OutletDeactivateRowResult[] = [];

  for (const row of rows) {
    const errors: string[] = [];

    // 1. Validate ID format
    if (!OUTLET_ID_RE.test(row.outletId)) {
      errors.push(`Invalid Outlet ID "${row.outletId}" — only alphanumeric characters and hyphens are allowed`);
    } else {
      // 2. Must exist in system
      const existing = outletMap.get(row.outletId);
      if (!existing) {
        errors.push(`Outlet ID "${row.outletId}" not found in the system`);
      } else if (!existing.isActive) {
        // 3. Must be currently active
        errors.push(`Outlet ID "${row.outletId}" is already inactive`);
      }

      // 4. No duplicates within the upload
      if (seenInUpload.has(row.outletId)) {
        errors.push(`Duplicate Outlet ID "${row.outletId}" — first seen at row ${seenInUpload.get(row.outletId)}`);
      } else {
        seenInUpload.set(row.outletId, row.rowNum);
      }
    }

    rowResults.push({
      rowNum:   row.rowNum,
      outletId: row.outletId,
      status:   errors.length > 0 ? 'ERROR' : 'OK',
      errors,
    });
  }

  const hasErrors     = rowResults.some(r => r.status === 'ERROR');
  const deactivates   = rowResults.filter(r => r.status === 'OK').length;
  const errorCount    = rowResults.filter(r => r.status === 'ERROR').length;

  return {
    headerError: null,
    rows:        rowResults,
    hasErrors,
    canProceed:  !hasErrors && rowResults.length > 0,
    summary:     { total: rowResults.length, deactivates, errors: errorCount },
  };
}

export function getDeactivateTemplateData(): OutletTemplateData {
  const headers = [...DEACTIVATE_HEADERS];

  const exampleRows: string[][] = [
    ['OUT-2026-001'],
    ['OUT-2026-002'],
  ];

  const dosAndDonts: string[][] = [
    ['OUTLET DEACTIVATION — Dos & Don\'ts', ''],
    ['', ''],
    ['WHAT THIS DOES', ''],
    ['IMPORTANT', 'This upload marks the listed outlets as inactive. Inactive outlets are hidden from the sales team\'s KYC queue and are excluded from target calculations. This action can be reversed by an admin but not via upload.'],
    ['', ''],
    ['COLUMN REFERENCE', ''],
    ['Outlet ID', 'The exact Outlet ID of the outlet to deactivate — must exist in the system and must currently be active'],
    ['', ''],
    ['✓ DOs', ''],
    ['DO', 'Confirm the Outlet ID exists in the system before uploading'],
    ['DO', 'Verify the outlet is currently active (not already inactive)'],
    ['DO', 'Co-ordinate with the field team before deactivating — the ISR will lose access immediately'],
    ['', ''],
    ['✗ DON\'Ts', ''],
    ['DON\'T', 'Include outlets that are already inactive — those rows will be rejected'],
    ['DON\'T', 'Use the same Outlet ID twice in one file'],
    ['DON\'T', 'Deactivate without cross-checking open KYC submissions — those remain in-flight and must be manually handled'],
    ['', ''],
    ['COMMON MISTAKES', ''],
    ['MISTAKE', 'Uploading an Outlet ID with spaces or extra characters — must be an exact match'],
    ['MISTAKE', 'Deactivating an outlet that still has active targets assigned for the current month'],
  ];

  return { headers, exampleRows, dosAndDonts };
}

// ─── HTML Operations Guide ────────────────────────────────────────────────────

export function generateOutletGuideHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Outlet Management — Operations Guide</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         font-size: 14px; line-height: 1.6; color: #1a1a1a; background: #f8f9fa; }
  .container { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 24px; font-weight: 700; color: #1A1A2E; border-bottom: 3px solid #22c55e;
       padding-bottom: 12px; margin-bottom: 24px; }
  h2 { font-size: 18px; font-weight: 600; color: #1A1A2E; margin: 32px 0 12px;
       padding-left: 12px; border-left: 4px solid #22c55e; }
  h3 { font-size: 15px; font-weight: 600; color: #374151; margin: 20px 0 8px; }
  p  { margin-bottom: 10px; color: #374151; }
  ul, ol { padding-left: 20px; margin-bottom: 12px; }
  li { margin-bottom: 6px; color: #374151; }
  .card { background: white; border: 1px solid #e5e7eb; border-radius: 12px;
          padding: 20px; margin-bottom: 20px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px;
           font-size: 12px; font-weight: 600; }
  .badge-green  { background: #dcfce7; color: #15803d; }
  .badge-blue   { background: #dbeafe; color: #1d4ed8; }
  .badge-amber  { background: #fef3c7; color: #92400e; }
  .badge-red    { background: #fee2e2; color: #991b1b; }
  .flow { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 12px; flex-wrap: wrap; }
  .flow-step { background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px;
               padding: 8px 12px; font-size: 13px; font-weight: 500; color: #15803d;
               min-width: 140px; flex: 1; }
  .flow-arrow { color: #9ca3af; font-size: 20px; padding-top: 8px; }
  .warn  { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px;
           padding: 12px 16px; margin: 12px 0; font-size: 13px; color: #78350f; }
  .info  { background: #eff6ff; border: 1px solid #93c5fd; border-radius: 8px;
           padding: 12px 16px; margin: 12px 0; font-size: 13px; color: #1e40af; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; }
  th    { background: #f3f4f6; text-align: left; padding: 8px 12px; font-size: 12px;
          font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.05em; }
  td    { padding: 8px 12px; border-bottom: 1px solid #f3f4f6; font-size: 13px; color: #374151; }
  tr:last-child td { border-bottom: none; }
  code  { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-family: monospace;
          font-size: 13px; color: #1f2937; }
  hr    { border: none; border-top: 1px solid #e5e7eb; margin: 24px 0; }
</style>
</head>
<body>
<div class="container">

<h1>Outlet Management — Operations Guide</h1>
<p>This guide covers all three outlet management operations: adding new outlets, re-assigning outlets to a different field rep, and flagging outlets for re-KYC. Read the relevant section before performing any bulk operation.</p>

<hr/>

<h2>1. Adding New Outlets (Outlet Addition Upload)</h2>

<h3>When to use this</h3>
<p>Use this when you need to register new outlets into the system. Once uploaded, the outlet appears in the assigned ISR's KYC dropdown and they can begin the KYC process.</p>

<h3>Full flow after upload</h3>
<div class="flow">
  <div class="flow-step">1. Admin uploads outlet list → outlets created (PENDING)</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">2. Assigned ISR sees outlet in KYC dropdown</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">3. ISR fills KYC form, verifies mobile via OTP</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">4. SO → ASM → Gifsy approval chain</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">5. Gifsy approves → outlet activated (isActive = true)</div>
</div>

<h3>Template column requirements</h3>
<table>
  <tr><th>Column</th><th>Required?</th><th>Rules</th></tr>
  <tr><td><code>Outlet ID</code></td><td><span class="badge badge-red">Required</span></td><td>Alphanumeric + hyphens only. Must be unique — upload rejected if ID already exists.</td></tr>
  <tr><td><code>Outlet Name</code></td><td><span class="badge badge-red">Required</span></td><td>Shop name as it appears</td></tr>
  <tr><td><code>Program Name</code></td><td><span class="badge badge-red">Required</span></td><td>Must match a value from Settings → Programs</td></tr>
  <tr><td><code>Program Category</code></td><td><span class="badge badge-red">Required</span></td><td>Must match a value from Settings → Program Categories</td></tr>
  <tr><td><code>Outlet Type</code></td><td><span class="badge badge-red">Required</span></td><td>Exactly: <code>SSS</code>, <code>WHOLESALER</code>, <code>SUB_STOCKIST</code>, or <code>SSS_TOT</code></td></tr>
  <tr><td><code>Beat</code></td><td><span class="badge badge-red">Required</span></td><td>Beat name for this outlet</td></tr>
  <tr><td><code>Distributor ID</code></td><td><span class="badge badge-green">Optional</span></td><td>Reference only — stored as-is, not validated</td></tr>
  <tr><td><code>Distributor Name</code></td><td><span class="badge badge-green">Optional</span></td><td>Reference only</td></tr>
  <tr><td><code>Metro</code></td><td><span class="badge badge-red">Required</span></td><td>Enter exactly <code>Yes</code> or <code>No</code></td></tr>
  <tr><td><code>City</code></td><td><span class="badge badge-red">Required</span></td><td></td></tr>
  <tr><td><code>State</code></td><td><span class="badge badge-red">Required</span></td><td></td></tr>
  <tr><td><code>XSR ID</code></td><td><span class="badge badge-red">Required</span></td><td>Must be a valid ISR-level employee ID in the Employee Hierarchy</td></tr>
</table>

<div class="warn">⚠ <strong>Outlet IDs are permanent.</strong> This upload only creates new outlets. If an Outlet ID already exists in the system, that row is rejected. To reassign an outlet to a different ISR, use the Re-tagging Upload.</div>

<h3>Common error scenarios</h3>
<ul>
  <li><strong>Row rejected: "already exists"</strong> — The Outlet ID was previously uploaded. Remove that row.</li>
  <li><strong>Row rejected: "not found in employee hierarchy"</strong> — The XSR ID in the last column doesn't exist. Upload the employee first via Employee Hierarchy upload.</li>
  <li><strong>Row rejected: "only ISR-level employees"</strong> — You entered an SO or ASM ID in the XSR ID column. Only ISR (field-rep level) IDs are accepted.</li>
  <li><strong>Row rejected: "program name not in configured list"</strong> — Go to Settings and check the exact program name configured.</li>
</ul>

<hr/>

<h2>2. Re-tagging Outlets to a Different ISR</h2>

<h3>When to use this</h3>
<p>Use when an ISR resigns, transfers, or when you need to redistribute outlet assignments across your field team.</p>

<h3>Template: 3 columns only</h3>
<table>
  <tr><th>Column</th><th>Rules</th></tr>
  <tr><td><code>Outlet ID</code></td><td>Must already exist in the system</td></tr>
  <tr><td><code>Sales Team Hierarchy</code></td><td>Must be <code>ISR</code> — no other role accepted</td></tr>
  <tr><td><code>Sales Team ID</code></td><td>The new ISR's employee ID — must exist in Employee Hierarchy and must match the role in the hierarchy column</td></tr>
</table>

<h3>What happens after upload</h3>
<ul>
  <li>The outlet is reassigned to the new ISR</li>
  <li>The full hierarchy chain (SO, ASM, RSM, ZNM, NSM above the new ISR) is automatically derived and updated</li>
  <li>If the outlet's KYC is still PENDING (not started), the new ISR picks it up from their queue</li>
  <li>If the outlet was already KYC-approved and active, it continues to be active under the new ISR</li>
  <li>Mid-month target changes: if the new ISR is in a different territory/config, the outlet's targets will reflect the new territory's config from the next resolution</li>
</ul>

<div class="info">ℹ <strong>Hierarchy is auto-derived.</strong> You only need to provide the ISR ID — the system automatically links the outlet to the ISR's SO, ASM, RSM, ZNM, and NSM chain from the Employee Hierarchy table.</div>

<h3>Common error scenarios</h3>
<ul>
  <li><strong>"Sales Team Hierarchy must be ISR"</strong> — Only ISR-level IDs are accepted. Do not use SO or ASM IDs.</li>
  <li><strong>"Sales Team ID not found"</strong> — The ISR doesn't exist in the employee hierarchy. Add them via Employee Hierarchy upload first.</li>
  <li><strong>"Hierarchy does not match actual role"</strong> — The employee ID you entered belongs to a different role (e.g., you typed an SO ID but put ISR in the Hierarchy column).</li>
</ul>

<hr/>

<h2>3. Flagging Outlets for Re-KYC</h2>

<h3>When to use this</h3>
<p>Use when KYC data for an outlet needs to be refreshed — e.g., owner changed, bank account changed, documents expired, address changed.</p>

<h3>How it works</h3>
<p>This upload does <strong>not</strong> change any KYC data directly. It flags which fields must be re-captured by the sales team in the field.</p>
<div class="flow">
  <div class="flow-step">1. Admin uploads Re-KYC flag file with "Yes" in relevant columns</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">2. Outlet shows "Re-KYC Required" badge in sales team's KYC list</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">3. ISR/SO opens the outlet — pre-filled with existing data except flagged fields</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">4. They re-enter/re-upload the flagged fields only</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">5. Same approval chain: SO → ASM → Gifsy</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">6. Outlet stays active throughout</div>
</div>

<h3>Template columns</h3>
<p>The template has one column for each KYC field. Enter <code>Yes</code> in any column where the data needs to be re-captured. Leave blank for fields that are fine as-is. Add a <strong>Remarks</strong> note to explain to the sales team why re-KYC is happening.</p>

<h3>Text fields vs Document fields</h3>
<table>
  <tr><th>Type</th><th>Fields</th><th>What the sales team does</th></tr>
  <tr><td><span class="badge badge-blue">Text</span></td><td>Owner Name, Mobile, GST, PAN, Address, City, Pincode, State, Bank Name, Account No., IFSC, UPI ID</td><td>Re-types the value in the KYC form</td></tr>
  <tr><td><span class="badge badge-amber">Document</span></td><td>GST Certificate, Owner Photo, Address Proof, Store Board Photo, Cancelled Cheque, Self Declaration</td><td>Re-uploads the file or retakes the photo via the KYC form camera</td></tr>
</table>

<div class="warn">⚠ <strong>Documents cannot be submitted via Excel.</strong> Flagging a document column as "Yes" means the ISR/SO must re-upload or re-photograph that document via the KYC form when they visit the outlet.</div>

<h3>Rules</h3>
<ul>
  <li>At least one column must be <code>Yes</code> — a row with no flags is rejected</li>
  <li>The outlet must exist in the system</li>
  <li>The outlet stays active (login not affected) while re-KYC is in progress</li>
  <li>Do not enter <code>No</code> explicitly — just leave the column blank</li>
</ul>

<hr/>

<h2>4. Edge Cases and Special Situations</h2>

<h3>ISR resigned — what happens to their outlets?</h3>
<ol>
  <li>Mark the ISR as resigned via Employee Hierarchy (PLACEHOLDER status or removed)</li>
  <li>Use Re-tagging Upload to assign their outlets to the replacement ISR</li>
  <li>Any pending KYC approvals will escalate automatically to the next manager in the chain</li>
</ol>

<h3>Outlet needs both re-tagging AND re-KYC</h3>
<ol>
  <li>Do the Re-tagging upload first (change the ISR)</li>
  <li>Then do the Re-KYC flag upload</li>
  <li>The new ISR will see the Re-KYC Required badge and handle it</li>
</ol>

<h3>Mid-month outlet activation for targets</h3>
<p>When an outlet is activated mid-month (KYC approved after the month has started), the admin can optionally include this outlet's ID in the target Excel upload for that month. Go to <strong>Admin → Targets</strong>, download the template for the relevant config, add the outlet's row with target values, and re-upload.</p>

<h3>New outlet not appearing in ISR's KYC dropdown</h3>
<ul>
  <li>Confirm the upload validation passed with no errors</li>
  <li>Check that the XSR ID in the upload matches the ISR who is logged in</li>
  <li>Verify the outlet's kycStatus is <code>PENDING</code> (not already started)</li>
</ul>

</div>
</body>
</html>`;
}
