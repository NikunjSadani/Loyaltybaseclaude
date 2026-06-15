/**
 * KYC Bulk Verification Parser
 *
 * Pure, deterministic engine for parsing and validating a Gifsy-filled
 * KYC approval sheet.  Called by the bulk-verify route handler.
 *
 * No DB access, no side effects — pure input → output.
 *
 * Spec: docs/plans/KYC-APPROVAL-REVAMP.md § The bulk flow (Lane A — step 3)
 */

import type { KycFieldKey, KycVerifyResult, KycVerifyUpdate, KycVerifyRowError } from '@/types';
import { KYC_FIELD_ORDER, kycFieldDecisionHeader, kycFieldRemarkHeader } from '@/lib/kyc-review-dump';

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parses and validates rows from a Gifsy-filled KYC approval sheet.
 *
 * Decision parse per field:
 *   blank      → skip (no update for this field)
 *   APPROVE / APPROVED → APPROVED
 *   REJECT / REJECTED  → REJECTED (requires non-empty remark, else row error)
 *   anything else      → row error "… is not APPROVE/REJECT"
 *
 * Unknown / blank Submission ID → row error.
 * A row with ANY error → 0 updates for that row + one errors entry
 * with message = all issues joined '; '.
 *
 * @param rawRows            Sheet rows keyed by header label (from XLSX sheet_to_json).
 * @param validSubmissionIds Set of known PENDING_GIFSY submission IDs.
 */
export function parseKycApprovalSheet(
  rawRows:             Record<string, string>[],
  validSubmissionIds:  Set<string>,
): KycVerifyResult {
  const updates: KycVerifyUpdate[]   = [];
  const errors:  KycVerifyRowError[] = [];
  let totalFieldsSet = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const row        = rawRows[i];
    const rowNumber  = i + 2;   // row 1 = header; data rows start at 2
    const rowErrors: string[] = [];

    // ── Submission ID ────────────────────────────────────────────────────────
    const submissionId = (row['Submission ID'] ?? '').trim();
    if (!submissionId || !validSubmissionIds.has(submissionId)) {
      rowErrors.push('Unknown or missing Submission ID');
    }

    // ── Parse per-field decisions ────────────────────────────────────────────
    type FieldUpdate = { decision: 'APPROVED' | 'REJECTED'; remark?: string };
    const fieldUpdates: Partial<Record<KycFieldKey, FieldUpdate>> = {};
    const fieldErrors:  string[] = [];

    for (const { key, label } of KYC_FIELD_ORDER) {
      const rawDecision = (row[kycFieldDecisionHeader(label)] ?? '').trim();
      const rawRemark   = (row[kycFieldRemarkHeader(label)]   ?? '').trim();

      if (rawDecision === '') continue;   // blank → skip this field

      const decisionUp = rawDecision.toUpperCase();

      if (decisionUp === 'APPROVE' || decisionUp === 'APPROVED') {
        fieldUpdates[key] = { decision: 'APPROVED', ...(rawRemark ? { remark: rawRemark } : {}) };
      } else if (decisionUp === 'REJECT' || decisionUp === 'REJECTED') {
        if (!rawRemark) {
          fieldErrors.push(`${label} rejected without a remark`);
        } else {
          fieldUpdates[key] = { decision: 'REJECTED', remark: rawRemark };
        }
      } else {
        fieldErrors.push(`${label} decision "${rawDecision}" is not APPROVE/REJECT`);
      }
    }

    rowErrors.push(...fieldErrors);

    // ── If any errors, record and skip ───────────────────────────────────────
    if (rowErrors.length > 0) {
      errors.push({
        rowNumber,
        submissionId: submissionId || '(blank)',
        message:      rowErrors.join('; '),
      });
      continue;
    }

    // ── Emit update (even if fieldUpdates is empty — blank row is still valid) ─
    const fieldsCount = Object.keys(fieldUpdates).length;
    totalFieldsSet += fieldsCount;

    updates.push({
      submissionId,
      fields: fieldUpdates,
    });
  }

  return {
    updates,
    errors,
    summary: {
      rowsParsed: rawRows.length,
      fieldsSet:  totalFieldsSet,
      errors:     errors.length,
    },
  };
}
