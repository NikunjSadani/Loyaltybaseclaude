/**
 * KYC Bulk Verification Parser
 *
 * Pure, deterministic engine for parsing and validating a Gifsy-filled
 * KYC verification sheet. Called by the bulk-verify route handler.
 *
 * No DB access, no side effects — pure input → output.
 *
 * Spec: docs/plans/KYC-APPROVAL-REVAMP.md § The bulk flow (Lane A — step 3)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type FieldStatus = 'VERIFIED' | 'REJECTED' | 'PENDING';

export interface KycVerifyPreviewRow {
  submissionId:         string;
  outletName:           string;
  bankStatus:           FieldStatus;
  gstStatus:            FieldStatus;
  addressStatus:        FieldStatus;
  ownerStatus:          FieldStatus;
  gstRegistrationType?: string;
  decision:             'APPROVE' | 'RE_UPLOAD' | 'REJECT';
  resultingStatus:      string;
  reason?:              string;
}

export interface KycVerifyError {
  rowNumber:    number;
  submissionId: string;
  message:      string;
}

export interface KycVerifyResult {
  previewRows: KycVerifyPreviewRow[];
  errors:      KycVerifyError[];
  summary: {
    toApprove:  number;
    toReupload: number;
    toReject:   number;
    errors:     number;
    total:      number;
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Row 1 is the header; data rows start at row 2. Used for human-friendly rowNumber in errors. */
export const KYC_VERIFY_ROW_NUMBER_OFFSET = 2;

const VALID_DECISIONS   = new Set(['APPROVE', 'RE_UPLOAD', 'REJECT']);
const VALID_GST_TYPES   = new Set(['REGULAR', 'COMPOSITE', 'UNREGISTERED']);
const VALID_YN          = new Set(['', 'Y', 'N']);

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parses and validates rows from a Gifsy-filled KYC verification sheet.
 *
 * @param rawRows           Sheet rows keyed by header label (from XLSX sheet_to_json).
 * @param validSubmissionIds Set of known PENDING_GIFSY submission IDs to validate against.
 *
 * Per-row validation:
 *   - Submission ID must be non-empty AND in validSubmissionIds.
 *   - Decision must be APPROVE|RE_UPLOAD|REJECT (case-insensitive, trimmed).
 *   - GST Registration Type, if provided, must be REGULAR|COMPOSITE|UNREGISTERED.
 *   - Y/N fields (Bank Verified, Address Approved, Owner Approved) must be blank or Y/N.
 *   - If Decision=APPROVE: Bank Verified=Y + GST Registration Type set + Address Approved=Y + Owner Approved=Y.
 *   - If Decision in {REJECT, RE_UPLOAD}: Reason must be non-empty.
 *   - A row with ANY error is NOT added to previewRows (only errors).
 */
export function parseKycVerificationRows(
  rawRows:             Record<string, string>[],
  validSubmissionIds:  Set<string>,
): KycVerifyResult {
  const previewRows: KycVerifyPreviewRow[] = [];
  const errors:      KycVerifyError[]      = [];

  for (let i = 0; i < rawRows.length; i++) {
    const row        = rawRows[i];
    const rowNumber  = i + KYC_VERIFY_ROW_NUMBER_OFFSET;
    const rowErrors: string[] = [];

    // ── Field extraction (trim everything) ───────────────────────────────────
    const submissionId      = (row['Submission ID']        ?? '').trim();
    const outletName        = (row['Outlet Name']          ?? '').trim();
    const bankVerified      = (row['Bank Verified']        ?? '').trim().toUpperCase();
    const bankNameMatch     = (row['Bank Name Match']      ?? '').trim();
    const pennyDropRef      = (row['Penny-drop Ref']       ?? '').trim();
    const gstRegistrationType = (row['GST Registration Type'] ?? '').trim().toUpperCase();
    const gstLegalName      = (row['GST Legal Name']       ?? '').trim();
    const gstStatus         = (row['GST Status']           ?? '').trim();
    const addressApproved   = (row['Address Approved']     ?? '').trim().toUpperCase();
    const ownerApproved     = (row['Owner Approved']       ?? '').trim().toUpperCase();
    const decisionRaw       = (row['Decision']             ?? '').trim().toUpperCase();
    const reason            = (row['Reason']               ?? '').trim();

    // Suppress unused-variable warnings for fields we read but don't validate further
    void bankNameMatch; void pennyDropRef; void gstLegalName; void gstStatus;

    // ── Validation ────────────────────────────────────────────────────────────

    // Submission ID
    if (!submissionId) {
      rowErrors.push('Unknown or missing Submission ID');
    } else if (!validSubmissionIds.has(submissionId)) {
      rowErrors.push('Unknown or missing Submission ID');
    }

    // Decision
    if (!VALID_DECISIONS.has(decisionRaw)) {
      rowErrors.push(`Invalid Decision "${decisionRaw}" — must be APPROVE, RE_UPLOAD, or REJECT`);
    }

    // GST Registration Type (if provided)
    if (gstRegistrationType !== '' && !VALID_GST_TYPES.has(gstRegistrationType)) {
      rowErrors.push(
        `Invalid GST Registration Type "${gstRegistrationType}" — must be REGULAR, COMPOSITE, or UNREGISTERED`,
      );
    }

    // Y/N fields
    if (!VALID_YN.has(bankVerified)) {
      rowErrors.push(`Invalid Bank Verified "${bankVerified}" — must be Y or N`);
    }
    if (!VALID_YN.has(addressApproved)) {
      rowErrors.push(`Invalid Address Approved "${addressApproved}" — must be Y or N`);
    }
    if (!VALID_YN.has(ownerApproved)) {
      rowErrors.push(`Invalid Owner Approved "${ownerApproved}" — must be Y or N`);
    }

    // Decision-specific rules (only enforce if decision is valid)
    if (VALID_DECISIONS.has(decisionRaw)) {
      if (decisionRaw === 'APPROVE') {
        const missing: string[] = [];
        if (bankVerified !== 'Y')         missing.push('Bank Verified=Y');
        if (gstRegistrationType === '')   missing.push('GST Registration Type');
        if (addressApproved !== 'Y')      missing.push('Address Approved=Y');
        if (ownerApproved !== 'Y')        missing.push('Owner Approved=Y');
        if (missing.length > 0) {
          rowErrors.push(`Decision=APPROVE requires: ${missing.join(', ')}`);
        }
      }

      if (decisionRaw === 'REJECT' || decisionRaw === 'RE_UPLOAD') {
        if (!reason) {
          rowErrors.push(`Decision=${decisionRaw} requires a non-empty Reason`);
        }
      }
    }

    // ── If any errors, skip to errors list ───────────────────────────────────
    if (rowErrors.length > 0) {
      errors.push({
        rowNumber,
        submissionId: submissionId || '(blank)',
        message:      rowErrors.join('; '),
      });
      continue;
    }

    // ── Map to preview row ────────────────────────────────────────────────────
    const isReject = decisionRaw === 'REJECT';

    const bankStatus: FieldStatus =
      bankVerified === 'Y' ? 'VERIFIED'
      : (isReject ? 'REJECTED' : 'PENDING');

    const addressStatus: FieldStatus =
      addressApproved === 'Y' ? 'VERIFIED'
      : (isReject ? 'REJECTED' : 'PENDING');

    const ownerStatus: FieldStatus =
      ownerApproved === 'Y' ? 'VERIFIED'
      : (isReject ? 'REJECTED' : 'PENDING');

    const gstFieldStatus: FieldStatus =
      gstRegistrationType !== '' ? 'VERIFIED'
      : (isReject ? 'REJECTED' : 'PENDING');

    const resultingStatus =
      decisionRaw === 'APPROVE'   ? 'APPROVED'
      : decisionRaw === 'RE_UPLOAD' ? 'RE_UPLOAD_REQUIRED'
      : 'REJECTED';

    const previewRow: KycVerifyPreviewRow = {
      submissionId,
      outletName,
      bankStatus,
      gstStatus:           gstFieldStatus,
      addressStatus,
      ownerStatus,
      decision:            decisionRaw as 'APPROVE' | 'RE_UPLOAD' | 'REJECT',
      resultingStatus,
    };

    if (gstRegistrationType) {
      previewRow.gstRegistrationType = gstRegistrationType;
    }
    if (reason) {
      previewRow.reason = reason;
    }

    previewRows.push(previewRow);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summary = {
    toApprove:  previewRows.filter(r => r.decision === 'APPROVE').length,
    toReupload: previewRows.filter(r => r.decision === 'RE_UPLOAD').length,
    toReject:   previewRows.filter(r => r.decision === 'REJECT').length,
    errors:     errors.length,
    total:      previewRows.length + errors.length,
  };

  return { previewRows, errors, summary };
}
