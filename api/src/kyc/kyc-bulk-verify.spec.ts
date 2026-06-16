/**
 * Tests for parseKycApprovalSheet — the pure Lane A bulk-verify parser.
 * Ported from platform/src/lib/kyc-bulk-verify.ts; self-contained (no mocks).
 */

import { KYC_FIELD_ORDER, kycFieldDecisionHeader, kycFieldRemarkHeader } from './kyc-review-dump';
import { parseKycApprovalSheet } from './kyc-bulk-verify';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SUB_ID = 'sub-valid-001';
const VALID_IDS = new Set([SUB_ID, 'sub-valid-002']);

/** Build a raw row with a given Submission ID and optional per-field overrides. */
function buildRow(
  submissionId: string,
  fields: Partial<Record<string, { decision?: string; remark?: string }>> = {},
): Record<string, unknown> {
  const row: Record<string, unknown> = { 'Submission ID': submissionId };
  for (const { label } of KYC_FIELD_ORDER) {
    row[kycFieldDecisionHeader(label)] = fields[label]?.decision ?? '';
    row[kycFieldRemarkHeader(label)] = fields[label]?.remark ?? '';
  }
  return row;
}

/** Short label-alias for the first field ('Payment (Bank/UPI)') */
const PAY_LABEL = KYC_FIELD_ORDER[0].label; // 'Payment (Bank/UPI)'
const GST_V_LABEL = KYC_FIELD_ORDER[1].label; // 'GST Validation'
const OWNER_LABEL = KYC_FIELD_ORDER[6].label; // 'Owner Photo'

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseKycApprovalSheet', () => {
  // ── Empty sheet ─────────────────────────────────────────────────────────────
  it('returns empty arrays and zero counts for an empty sheet', () => {
    const result = parseKycApprovalSheet([], VALID_IDS);
    expect(result.updates).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.summary).toEqual({ rowsParsed: 0, fieldsSet: 0, errors: 0 });
  });

  // ── Blank Submission ID ──────────────────────────────────────────────────────
  it('records a row error for a blank Submission ID', () => {
    const result = parseKycApprovalSheet([buildRow('')], VALID_IDS);
    expect(result.updates).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].submissionId).toBe('(blank)');
    expect(result.errors[0].message).toContain('Unknown or missing Submission ID');
    expect(result.errors[0].rowNumber).toBe(2);
  });

  // ── Unknown Submission ID ────────────────────────────────────────────────────
  it('records a row error for an unknown Submission ID', () => {
    const result = parseKycApprovalSheet([buildRow('UNKNOWN-ID')], VALID_IDS);
    expect(result.updates).toHaveLength(0);
    expect(result.errors[0].submissionId).toBe('UNKNOWN-ID');
  });

  // ── All blank fields → valid update with 0 fields (blank row is still valid) ─
  it('accepts a fully-blank row (no fields set) as a valid update with 0 fieldUpdates', () => {
    const result = parseKycApprovalSheet([buildRow(SUB_ID)], VALID_IDS);
    expect(result.errors).toHaveLength(0);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].submissionId).toBe(SUB_ID);
    expect(Object.keys(result.updates[0].fields)).toHaveLength(0);
    expect(result.summary.fieldsSet).toBe(0);
  });

  // ── APPROVE / APPROVED case-insensitive → APPROVED ──────────────────────────
  it('maps APPROVE → APPROVED', () => {
    const result = parseKycApprovalSheet(
      [buildRow(SUB_ID, { [PAY_LABEL]: { decision: 'APPROVE' } })],
      VALID_IDS,
    );
    expect(result.errors).toHaveLength(0);
    expect(result.updates[0].fields['PAYMENT']?.decision).toBe('APPROVED');
  });

  it('maps APPROVED (already) → APPROVED', () => {
    const result = parseKycApprovalSheet(
      [buildRow(SUB_ID, { [PAY_LABEL]: { decision: 'APPROVED' } })],
      VALID_IDS,
    );
    expect(result.updates[0].fields['PAYMENT']?.decision).toBe('APPROVED');
  });

  it('is case-insensitive for APPROVE', () => {
    const result = parseKycApprovalSheet(
      [buildRow(SUB_ID, { [PAY_LABEL]: { decision: 'approve' } })],
      VALID_IDS,
    );
    expect(result.updates[0].fields['PAYMENT']?.decision).toBe('APPROVED');
  });

  // ── REJECT with remark → REJECTED ───────────────────────────────────────────
  it('maps REJECT with remark → REJECTED', () => {
    const result = parseKycApprovalSheet(
      [buildRow(SUB_ID, { [PAY_LABEL]: { decision: 'REJECT', remark: 'Bank name mismatch' } })],
      VALID_IDS,
    );
    expect(result.errors).toHaveLength(0);
    expect(result.updates[0].fields['PAYMENT']).toEqual({
      decision: 'REJECTED',
      remark: 'Bank name mismatch',
    });
  });

  it('maps REJECTED (long form) with remark → REJECTED', () => {
    const result = parseKycApprovalSheet(
      [buildRow(SUB_ID, { [PAY_LABEL]: { decision: 'REJECTED', remark: 'A reason' } })],
      VALID_IDS,
    );
    expect(result.updates[0].fields['PAYMENT']?.decision).toBe('REJECTED');
  });

  // ── REJECT without remark → row error ───────────────────────────────────────
  it('errors a row when REJECT has no remark', () => {
    const result = parseKycApprovalSheet(
      [buildRow(SUB_ID, { [PAY_LABEL]: { decision: 'REJECT', remark: '' } })],
      VALID_IDS,
    );
    expect(result.updates).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/rejected without a remark/i);
  });

  // ── Unknown decision → row error ─────────────────────────────────────────────
  it('errors a row for an unrecognised decision string', () => {
    const result = parseKycApprovalSheet(
      [buildRow(SUB_ID, { [PAY_LABEL]: { decision: 'OK' } })],
      VALID_IDS,
    );
    expect(result.updates).toHaveLength(0);
    expect(result.errors[0].message).toMatch(/is not APPROVE\/REJECT/i);
  });

  // ── Multiple field errors on one row → combined message ─────────────────────
  it('combines multiple field errors on one row into one errors entry', () => {
    const result = parseKycApprovalSheet(
      [
        buildRow(SUB_ID, {
          [PAY_LABEL]: { decision: 'REJECT', remark: '' },        // remark missing
          [GST_V_LABEL]: { decision: 'OK' },                       // unknown
          [OWNER_LABEL]: { decision: 'REJECT', remark: '' },       // remark missing
        }),
      ],
      VALID_IDS,
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain('rejected without a remark');
    expect(result.errors[0].message).toContain('is not APPROVE/REJECT');
  });

  // ── One errored row does not affect other rows ────────────────────────────────
  it('isolates a row error — the other row succeeds', () => {
    const result = parseKycApprovalSheet(
      [
        buildRow(SUB_ID, { [PAY_LABEL]: { decision: 'APPROVE' } }),
        buildRow('sub-valid-002', { [PAY_LABEL]: { decision: 'REJECT', remark: '' } }),
      ],
      VALID_IDS,
    );
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0].submissionId).toBe(SUB_ID);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].submissionId).toBe('sub-valid-002');
  });

  // ── Summary accounting ────────────────────────────────────────────────────────
  it('counts rowsParsed, fieldsSet, and errors correctly', () => {
    const result = parseKycApprovalSheet(
      [
        buildRow(SUB_ID, {
          [PAY_LABEL]: { decision: 'APPROVE' },
          [OWNER_LABEL]: { decision: 'APPROVE' },
        }),
        buildRow('UNKNOWN', { [PAY_LABEL]: { decision: 'APPROVE' } }),
      ],
      VALID_IDS,
    );
    expect(result.summary.rowsParsed).toBe(2);
    expect(result.summary.fieldsSet).toBe(2); // only from the successful row
    expect(result.summary.errors).toBe(1);
  });

  // ── Blank cells skip the field (merge semantics) ────────────────────────────
  it('skips fields whose decision cell is blank (merge — never clears existing state)', () => {
    const result = parseKycApprovalSheet(
      [buildRow(SUB_ID, { [PAY_LABEL]: { decision: 'APPROVE' } })],
      VALID_IDS,
    );
    // Only PAYMENT is set; the other 6 are absent from the update's fields map
    expect(Object.keys(result.updates[0].fields)).toEqual(['PAYMENT']);
  });

  // ── Row numbers are 1-indexed from Excel perspective ────────────────────────
  it('assigns rowNumber=2 to the first data row', () => {
    const result = parseKycApprovalSheet(
      [buildRow('UNKNOWN')],
      new Set<string>(),
    );
    expect(result.errors[0].rowNumber).toBe(2);
  });

  it('assigns rowNumber=3 to the second data row', () => {
    const result = parseKycApprovalSheet(
      [buildRow(SUB_ID), buildRow('UNKNOWN')],
      VALID_IDS,
    );
    expect(result.errors[0].rowNumber).toBe(3);
  });

  // ── All 7 fields approved ────────────────────────────────────────────────────
  it('parses all 7 APPROVE fields correctly', () => {
    const allFields: Record<string, { decision: string }> = {};
    for (const { label } of KYC_FIELD_ORDER) allFields[label] = { decision: 'APPROVE' };
    const result = parseKycApprovalSheet([buildRow(SUB_ID, allFields)], VALID_IDS);
    expect(result.errors).toHaveLength(0);
    expect(Object.keys(result.updates[0].fields)).toHaveLength(7);
    for (const key of Object.keys(result.updates[0].fields)) {
      expect(result.updates[0].fields[key as keyof typeof result.updates[0]['fields']]?.decision).toBe('APPROVED');
    }
    expect(result.summary.fieldsSet).toBe(7);
  });
});
