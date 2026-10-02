/**
 * Points Compute Engine — Wave 1 compute/preview CONTRACT (read-only route).
 *
 * The compute service loads raw achievements + targets + segment per outlet, resolves the effective
 * published rule (getActiveForAttachment), runs the PURE evaluator (points-engine.helper), and produces
 * a PREVIEW: one row per (outlet × resolved rule) with status + points + an explanation. The preview is
 * read-only (NO wallet write in Wave 1); its OK rows map 1:1 to the existing credits `UploadRowDto` shape
 * so the export plugs straight into the existing credits-upload flow after offline approval.
 *
 * See POINTS-COMPUTE-ENGINE-DESIGN.md §6 (integration) + §11 (Wave 1).
 */

export type PreviewRowStatus = 'OK' | 'SKIP' | 'ERROR' | 'NO_RULE';

/** One computed line for one outlet under its resolved rule (or a skip/no-rule marker). */
export interface ComputePreviewRow {
  outletCode: string;
  outletName?: string | null;
  program?: string | null;
  programCategory?: string | null;
  kpiCode: string;
  /** Resolved rule identity (absent when NO_RULE). */
  ruleId?: string;
  ruleVersion?: number;
  /** The credit bucket the points would land in (from rule.output) — for the upload/export. */
  awardType?: 'POINTS' | 'PAYOUT';
  fieldId?: string;
  /**
   * Resolved CreditField NAME for `fieldId`. REQUIRED for the credit-upload export to round-trip:
   * the existing credits upload parser (platform/src/lib/credits-payouts-parser.ts) matches each
   * value column by the CreditField's NAME (headerRow.indexOf(field.name)), NOT by fieldId — so the
   * exported sheet's value-column headers must be the field names. The compute service resolves this
   * from the rule's output CreditField when it builds the preview. (Optional in the type so a NO_RULE
   * row need not carry it; buildCreditUploadXlsx falls back to fieldId only as a last resort.)
   */
  fieldName?: string;
  status: PreviewRowStatus;
  /** Present only when status === 'OK' — whole, non-negative, safe integer. */
  points?: number;
  /** Raw inputs echoed for the preview report (achievement + target for the primary KPI). */
  achievement?: number | null;
  target?: number | null;
  /** Why a row did not produce points (SKIP reason / ERROR messages / 'no active rule'). */
  reason?: string;
  /** One-line human explanation of the math (from the evaluator trace) for the preview report. */
  explanation?: string;
}

/** A full compute run's preview for one (clientId × period), before any crediting. */
export interface ComputePreview {
  clientId: string;
  /** "YYYY-MM" period the achievements/targets were read for. */
  period: string;
  /** Optional filters the run was scoped to. */
  filter?: { program?: string | null; kpiCode?: string | null };
  counts: { total: number; ok: number; skip: number; error: number; noRule: number };
  /** Σ points over OK rows (whole). */
  totalPoints: number;
  rows: ComputePreviewRow[];
  /** True if the per-tenant engine flag is OFF (preview still allowed, but flagged — can't be credited). */
  engineDisabled: boolean;
  /** Rule-version content-hash set used — frozen into a batch later (Wave 2). */
  ruleVersionsUsed: Array<{ ruleId: string; version: number }>;
}
