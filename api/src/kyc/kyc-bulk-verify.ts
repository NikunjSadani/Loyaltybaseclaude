/**
 * kyc-bulk-verify.ts
 *
 * Pure, deterministic parser for the Gifsy-filled KYC approval sheet (Lane A).
 * No DB, no I/O — pure input → output.  Ported from platform/src/lib/kyc-bulk-verify.ts.
 *
 * Spec: docs/plans/reconcile/P3-onboarding-kyc.md §6
 *       docs/plans/KYC-APPROVAL-REVAMP.md § The bulk flow (Lane A — step 3)
 *
 * Types are self-contained here (do NOT import from platform's @/types).
 */

import { KycFieldKey } from '@prisma/client';
import { KYC_FIELD_ORDER, kycFieldDecisionHeader, kycFieldRemarkHeader } from './kyc-review-dump';

// ─── Public types ─────────────────────────────────────────────────────────────

/** A per-field update that the commit will upsert.  Decision is terminal only. */
export interface KycFieldUpdate {
  decision: 'APPROVED' | 'REJECTED';
  remark?: string;
}

/** One row's worth of validated updates (may have 0 fieldUpdates for a fully-blank row). */
export interface KycVerifyUpdate {
  submissionId: string;
  fields: Partial<Record<KycFieldKey, KycFieldUpdate>>;
}

/** A row that could not be parsed; skipped from `updates`. */
export interface KycVerifyRowError {
  rowNumber: number;
  submissionId: string;
  message: string;
}

export interface KycVerifyParseResult {
  updates: KycVerifyUpdate[];
  errors: KycVerifyRowError[];
  summary: {
    rowsParsed: number;
    fieldsSet: number;
    errors: number;
  };
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parses and validates rows from a Gifsy-filled KYC approval sheet.
 *
 * Decision rules per field:
 *   blank                            → skip field (merge semantics: blank never clears)
 *   APPROVE / APPROVED (case-insensitive) → APPROVED (remark optional)
 *   REJECT  / REJECTED (case-insensitive) → REJECTED (requires non-empty remark, else row error)
 *   anything else                         → row error "… is not APPROVE/REJECT"
 *
 * Row-level rules:
 *   Unknown or blank Submission ID → row error (skipped from updates)
 *   Any field-level error on the row → entire row becomes a row error (no partial updates)
 *
 * @param rawRows            Sheet rows keyed by header label (from XLSX.utils.sheet_to_json).
 * @param validSubmissionIds Set of known PENDING_GIFSY submission IDs for this tenant.
 */
export function parseKycApprovalSheet(
  rawRows: Record<string, unknown>[],
  validSubmissionIds: Set<string>,
): KycVerifyParseResult {
  const updates: KycVerifyUpdate[] = [];
  const errors: KycVerifyRowError[] = [];
  let totalFieldsSet = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i] as Record<string, string>;
    const rowNumber = i + 2; // row 1 = header; data rows start at 2
    const rowErrors: string[] = [];

    // ── Submission ID ──────────────────────────────────────────────────────────
    const submissionId = (row['Submission ID'] ?? '').toString().trim();
    if (!submissionId || !validSubmissionIds.has(submissionId)) {
      rowErrors.push('Unknown or missing Submission ID');
    }

    // ── Parse per-field decisions ──────────────────────────────────────────────
    const fieldUpdates: Partial<Record<KycFieldKey, KycFieldUpdate>> = {};
    const fieldErrors: string[] = [];

    for (const { key, label } of KYC_FIELD_ORDER) {
      const rawDecision = ((row[kycFieldDecisionHeader(label)] ?? '') as string).trim();
      const rawRemark = ((row[kycFieldRemarkHeader(label)] ?? '') as string).trim();

      if (rawDecision === '') continue; // blank → skip this field (merge semantics)

      const decisionUp = rawDecision.toUpperCase();

      if (decisionUp === 'APPROVE' || decisionUp === 'APPROVED') {
        fieldUpdates[key] = {
          decision: 'APPROVED',
          ...(rawRemark ? { remark: rawRemark } : {}),
        };
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

    // ── If any errors → record and skip ───────────────────────────────────────
    if (rowErrors.length > 0) {
      errors.push({
        rowNumber,
        submissionId: submissionId || '(blank)',
        message: rowErrors.join('; '),
      });
      continue;
    }

    // ── Emit update (blank-field-only rows are valid but add 0 to fieldsSet) ──
    const fieldsCount = Object.keys(fieldUpdates).length;
    totalFieldsSet += fieldsCount;

    updates.push({ submissionId, fields: fieldUpdates });
  }

  return {
    updates,
    errors,
    summary: {
      rowsParsed: rawRows.length,
      fieldsSet: totalFieldsSet,
      errors: errors.length,
    },
  };
}
