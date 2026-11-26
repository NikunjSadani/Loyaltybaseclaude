/**
 * Points Compute Engine — EXPORT writers (PURE layouts; no Nest/Prisma/DB). They write a read-only
 * {@link ComputePreview} into the streaming xlsx writer; the 'points-*' export kinds
 * (exports/kinds/batch2/points-compute.kinds.ts) run the compute and call them — in the background worker.
 *
 *  1. writeCreditUploadXlsx — the machine file the operator re-uploads, UNCHANGED, through the
 *     EXISTING credits-upload flow after the client approves the preview offline. It therefore
 *     reproduces the EXACT sheet shape that `generateCreditTemplate` emits and
 *     `parseCreditUpload` reads (platform/src/lib/credits-payouts-template.ts +
 *     credits-payouts-parser.ts):
 *
 *        Sheet[0] (any name)
 *          Row 0: a TITLE cell          (the parser skips row 0)
 *          Row 1: HEADERS               → "Outlet ID" | "Outlet Name" | <field name>… | "<field name> Narration"…
 *          Row 2+: one DATA row per outlet; each <field name> cell holds the WHOLE points for that
 *                  (outlet × field); narration cells are present (blank) to mirror the template.
 *
 *     The parser keys value columns by the CreditField NAME (headerRow.indexOf(field.name)), keys data
 *     by "Outlet ID", treats a blank/0 cell as SKIP (so outlets missing a given field are fine), and
 *     derives POINTS-vs-PAYOUT per the LIVE field config at upload time (the file never states it). The
 *     engine computes WHOLE POINTS (no ×100) — so every value cell is a whole points count and the
 *     target CreditField must be POINTS-classified for the outlet types involved.
 *
 *  2. writePreviewReportXlsx — the full human review report (POINTS) the operator shares with the client
 *     offline: one row per preview row (every status, with the math explanation) + a summary.
 *
 *  3. writePayoutReportXlsx — the PAYOUT report (report-only; the engine never credits/pays a payout —
 *     owner directive 2026-10-21, PAYOUT-COMPUTE-REPORT.md): one row per PAYOUT row with the amount in
 *     WHOLE INR on OK rows + a payout summary. Shared with the client for offline approval; the final
 *     payment status is then uploaded through the existing payout flow, not through the engine.
 *
 * Sanitisation (cellSafe) is applied by the streaming writer to every string cell and header.
 */

import type { XlsxStreamWriter } from '../common/xlsx-stream';
import { JsonSheet } from '../exports/kinds/batch2/kind-support';
import type { ComputePreview, ComputePreviewRow } from './points-compute.types';

// ─── Headers the credits upload parser REQUIRES verbatim ───────────────────────
// Mirrors platform/src/lib/credits-payouts-template.ts (do not rename — the parser does an exact
// string match on these).
const OUTLET_ID_HEADER = 'Outlet ID';
const OUTLET_NAME_HEADER = 'Outlet Name';
/** Narration column suffix (`"<field name> Narration"`) the template/parser use. */
const NARRATION_SUFFIX = ' Narration';
/** The template's sheet name. The parser reads SheetNames[0] regardless, but we match for fidelity. */
const CREDIT_SHEET_NAME = 'Credits & Payouts';

/** Month label for the title row — mirrors generateCreditTemplate's `monthLabel` (display-only). */
function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  if (!y || !m) return yyyyMm;
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

/** Column header for a field — the CreditField NAME (what the parser matches). Falls back to the
 *  fieldId only if a name was not resolved (a non-round-tripping last resort — see fieldName docs). */
function fieldHeader(row: ComputePreviewRow): string {
  return (row.fieldName && row.fieldName.trim()) || row.fieldId || '';
}

/**
 * Write the operator-reuploadable credit-upload xlsx from the preview's OK rows ONLY.
 * Rows that are not OK, or carry no numeric points, or have no resolvable credit field, are excluded
 * (they can never credit). Multiple OK rows for the SAME (outlet × field) are SUMMED into the one cell
 * the wide template allows (which also side-steps the parser's in-file duplicate-row ERROR).
 * Returns the number of outlet rows written.
 */
export async function writeCreditUploadXlsx(preview: ComputePreview, out: XlsxStreamWriter): Promise<number> {
  const okRows = preview.rows.filter(
    (r) =>
      r.status === 'OK' &&
      typeof r.points === 'number' &&
      Number.isInteger(r.points) && // POINTS are a whole count; the parser rejects >1-decimal values
      fieldHeader(r) !== '',
  );

  // Field columns: first-seen order, keyed by the resolved header (the CreditField name the parser
  // matches). Keyed by header rather than fieldId so a (missing-name) fallback can't collide.
  const fieldOrder: string[] = [];
  const seenField = new Set<string>();
  // Outlet rows: first-seen order; keep the first non-empty name seen for each outlet.
  const outletOrder: string[] = [];
  const outletName = new Map<string, string>();
  // (outletCode → header → summed whole points).
  const cell = new Map<string, Map<string, number>>();
  // (outletCode → header → narration) — quarter rows only; monthly narration cells stay blank (unchanged).
  const narr = new Map<string, Map<string, string>>();

  for (const r of okRows) {
    const header = fieldHeader(r);
    if (!seenField.has(header)) {
      seenField.add(header);
      fieldOrder.push(header);
    }
    if (!outletName.has(r.outletCode)) {
      outletOrder.push(r.outletCode);
      outletName.set(r.outletCode, (r.outletName && r.outletName.trim()) || r.outletCode);
    } else if (
      (!outletName.get(r.outletCode) || outletName.get(r.outletCode) === r.outletCode) &&
      r.outletName &&
      r.outletName.trim()
    ) {
      outletName.set(r.outletCode, r.outletName.trim());
    }
    let byField = cell.get(r.outletCode);
    if (!byField) {
      byField = new Map<string, number>();
      cell.set(r.outletCode, byField);
    }
    byField.set(header, (byField.get(header) ?? 0) + (r.points as number));
    // Quarter rows carry a narration naming the quarter; the first one per (outlet × field) fills the cell.
    if (r.narration) {
      let byFieldN = narr.get(r.outletCode);
      if (!byFieldN) narr.set(r.outletCode, (byFieldN = new Map<string, string>()));
      if (!byFieldN.has(header)) byFieldN.set(header, r.narration);
    }
  }

  // Row 0 is the TITLE and row 1 the header — the exact layout parseCreditUpload expects (it reads headers at
  // index 1, data at index 2+). Header row: fixed cols + value cols + narration cols (value cols THEN narration).
  // A quarter file names the quarter AND the month to upload it under (credit batches are month-keyed).
  const title = preview.quarter
    ? `Credits & Payouts Data — ${preview.quarter.label} (${preview.quarter.fyLabel}) — upload under ${monthLabel(preview.quarter.creditPeriod)}`
    : `Credits & Payouts Data — ${monthLabel(preview.period)}`;
  const sheet = await out.addSheet(CREDIT_SHEET_NAME, [title]);
  await sheet.addRow([OUTLET_ID_HEADER, OUTLET_NAME_HEADER, ...fieldOrder, ...fieldOrder.map((f) => `${f}${NARRATION_SUFFIX}`)]);

  // Data rows: one per outlet. Value = whole points (blank when this outlet has no such field).
  // Narration cells are present but blank — the parser treats them as optional display text.
  for (const code of outletOrder) {
    const byField = cell.get(code) ?? new Map<string, number>();
    const row: (string | number)[] = [code, outletName.get(code) ?? code];
    for (const f of fieldOrder) {
      const v = byField.get(f);
      row.push(v === undefined ? '' : v);
    }
    const byFieldN = narr.get(code);
    for (const f of fieldOrder) row.push(byFieldN?.get(f) ?? '');
    await sheet.addRow(row);
  }
  return outletOrder.length;
}

// ─── Preview report (human review) ─────────────────────────────────────────────

/** Column headers of the "Preview Rows" sheet — stable, explicit order. */
export const PREVIEW_REPORT_COLUMNS = [
  'Outlet Code',
  'Outlet Name',
  'Program',
  'KPI Code',
  'Achievement',
  'Target',
  'Status',
  'Points',
  'Reason / Explanation',
  'Rule Name',
  'Rule ID',
  'Rule Version',
] as const;

/** Column headers of the "Summary" sheet. */
export const PREVIEW_SUMMARY_COLUMNS = [
  'Client',
  'Period',
  'Total',
  'OK',
  'Skip',
  'Error',
  'No Rule',
  'Total Points',
  'Engine Disabled',
] as const;

function num(v: number | null | undefined): number | string {
  return typeof v === 'number' && Number.isFinite(v) ? v : '';
}

/**
 * The "Reason / Explanation" cell: a non-OK row's reason, an OK row's explanation, and — when an OK row paid 0 for a
 * stated reason (an opt-in gate failReason, or "No <KPI> target") — "<reason> — <explanation>". A row with only one
 * of the two is byte-identical to before.
 */
function reasonCell(r: ComputePreviewRow): string {
  return [r.reason, r.explanation].filter((x): x is string => typeof x === 'string' && x !== '').join(' — ');
}

function statusCounts(rows: ComputePreviewRow[]) {
  const counts = { ok: 0, skip: 0, error: 0, noRule: 0 };
  for (const r of rows) {
    if (r.status === 'OK') counts.ok++;
    else if (r.status === 'SKIP') counts.skip++;
    else if (r.status === 'ERROR') counts.error++;
    else counts.noRule++;
  }
  return counts;
}

/**
 * Write the full human-readable preview report: a "Preview Rows" sheet (one row per preview row, EVERY
 * status, with the math explanation) + a "Summary" sheet (the run's counts + total points + the
 * engine-disabled flag). This is what the operator shares with the client offline for approval before
 * re-uploading the credit-upload file. Returns the number of preview rows written.
 */
export async function writePreviewReportXlsx(preview: ComputePreview, out: XlsxStreamWriter): Promise<number> {
  // POINTS report: exclude PAYOUT rows (they live in the payout report). NO_RULE rows carry no award type
  // and belong here (the primary view). Keeping this symmetric with the payout report means the counts
  // reconcile — a mixed run no longer shows PAYOUT outlets as OK/blank-points with a summary that counts
  // them in OK but not in Total Points.
  const pointsRows = preview.rows.filter((r) => r.awardType !== 'PAYOUT');

  const sheet = new JsonSheet(out, 'Preview Rows');
  for (const r of pointsRows) {
    await sheet.add({
      'Outlet Code': r.outletCode,
      'Outlet Name': (r.outletName && r.outletName.trim()) || '',
      Program: (r.program && r.program.trim()) || '',
      'KPI Code': r.kpiCode,
      Achievement: num(r.achievement),
      Target: num(r.target),
      Status: r.status,
      // Whole points only on OK rows; blank otherwise (no points to show).
      Points: r.status === 'OK' ? num(r.points) : '',
      // SKIP/ERROR/NO_RULE carry a `reason`; OK rows carry the trace `explanation` (+ a `reason` when they paid 0).
      'Reason / Explanation': reasonCell(r),
      // Display name (blank when the rule is unnamed or there is no rule) — the Rule ID stays the identity.
      'Rule Name': r.ruleName ?? '',
      'Rule ID': r.ruleId ?? '',
      'Rule Version': typeof r.ruleVersion === 'number' ? r.ruleVersion : '',
    });
  }
  const written = await sheet.end();

  // Points-only counts (the preview counts cover ALL rows, points + payout).
  const counts = statusCounts(pointsRows);
  const summary = new JsonSheet(out, 'Summary');
  await summary.add({
    Client: preview.clientId,
    Period: preview.period,
    Total: pointsRows.length,
    OK: counts.ok,
    Skip: counts.skip,
    Error: counts.error,
    'No Rule': counts.noRule,
    'Total Points': preview.totalPoints,
    'Engine Disabled': preview.engineDisabled,
  });
  await summary.end();
  return written;
}

// ─── Payout report (report-only; NEVER credited) ─────────────────────────────────

/** Column headers of the "Payout Rows" sheet. */
export const PAYOUT_REPORT_COLUMNS = [
  'Outlet Code',
  'Outlet Name',
  'Program',
  'KPI Code',
  'Achievement',
  'Target',
  'Status',
  'Payout (INR)',
  'Reason / Explanation',
  'Rule Name',
  'Rule ID',
  'Rule Version',
] as const;

/** Column headers of the payout "Summary" sheet. */
export const PAYOUT_SUMMARY_COLUMNS = [
  'Client',
  'Period',
  'Payout Rows',
  'OK',
  'Skip',
  'Error',
  'No Rule',
  'Total Payout (INR)',
] as const;

/**
 * Write the PAYOUT report the operator shares with the client offline.
 *
 * PAYOUT is COMPUTE-TO-REPORT only (owner directive 2026-10-21 — PAYOUT-COMPUTE-REPORT.md): the engine
 * never credits or pays it. This report lists every PAYOUT row (one per outlet × PAYOUT rule, every
 * status) with the computed amount in WHOLE INR on OK rows, plus a summary. After the client approves it
 * offline, the final payment status is uploaded through the existing payout flow — not here.
 *
 * Only rows whose resolved rule output is a PAYOUT award are included (the engine sets `payoutRupees` and
 * clears `points` for those). POINTS rows live in the credit-upload file + preview report, not here.
 * Returns the number of payout rows written.
 */
export async function writePayoutReportXlsx(preview: ComputePreview, out: XlsxStreamWriter): Promise<number> {
  const payoutRows = preview.rows.filter((r) => r.awardType === 'PAYOUT');

  const sheet = new JsonSheet(out, 'Payout Rows');
  for (const r of payoutRows) {
    await sheet.add({
      'Outlet Code': r.outletCode,
      'Outlet Name': (r.outletName && r.outletName.trim()) || '',
      Program: (r.program && r.program.trim()) || '',
      'KPI Code': r.kpiCode,
      Achievement: num(r.achievement),
      Target: num(r.target),
      Status: r.status,
      // Whole INR only on OK rows; blank otherwise (no amount to pay).
      'Payout (INR)': r.status === 'OK' ? num(r.payoutRupees) : '',
      // SKIP/ERROR/NO_RULE carry a `reason`; OK rows carry the trace `explanation` (+ a `reason` when they paid 0).
      'Reason / Explanation': reasonCell(r),
      // Display name (blank when the rule is unnamed or there is no rule) — the Rule ID stays the identity.
      'Rule Name': r.ruleName ?? '',
      'Rule ID': r.ruleId ?? '',
      'Rule Version': typeof r.ruleVersion === 'number' ? r.ruleVersion : '',
    });
  }
  const written = await sheet.end();

  // Payout-specific counts (the preview counts cover ALL rows, points + payout).
  const counts = statusCounts(payoutRows);
  const summary = new JsonSheet(out, 'Summary');
  await summary.add({
    Client: preview.clientId,
    Period: preview.period,
    'Payout Rows': payoutRows.length,
    OK: counts.ok,
    Skip: counts.skip,
    Error: counts.error,
    'No Rule': counts.noRule,
    'Total Payout (INR)': preview.totalPayoutRupees,
  });
  await summary.end();
  return written;
}
