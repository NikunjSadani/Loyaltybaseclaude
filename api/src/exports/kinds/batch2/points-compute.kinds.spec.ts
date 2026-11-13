import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { aoaToSheetSafe, buildXlsx } from '../../../common/xlsx';
import type { JwtPayload } from '../../../common/decorators/current-user.decorator';
import { PointsComputeService } from '../../../points-engine/points-compute.service';
import type { ComputePreview, ComputePreviewRow } from '../../../points-engine/points-compute.types';
import { TenantSettingsService } from '../../../tenant/tenant-settings.service';
import { SalesMonthClosedGuard } from '../../../sales-import/months/sales-month-closed.guard';
import {
  POINTS_CREDIT_UPLOAD_KIND,
  POINTS_ENGINE_DISABLED_MESSAGE,
  POINTS_PAYOUT_REPORT_KIND,
  POINTS_PREVIEW_REPORT_KIND,
} from './points-compute.kinds';
import { ctxFor, expectSameWorkbook, readBook, renderKind } from './parity.support-spec';

// ═══ REFERENCE COPY of the old in-memory builders (points-compute-export.helper.ts before the Downloads page) ═════
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
 * Build the operator-reuploadable credit-upload xlsx from the preview's OK rows ONLY.
 * Rows that are not OK, or carry no numeric points, or have no resolvable credit field, are excluded
 * (they can never credit). Multiple OK rows for the SAME (outlet × field) are SUMMED into the one cell
 * the wide template allows (which also side-steps the parser's in-file duplicate-row ERROR).
 */
function old_buildCreditUploadXlsx(preview: ComputePreview): Buffer {
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
  }

  // Header row: fixed cols + value cols + narration cols (value cols THEN narration cols, as template).
  const headers: string[] = [
    OUTLET_ID_HEADER,
    OUTLET_NAME_HEADER,
    ...fieldOrder,
    ...fieldOrder.map((f) => `${f}${NARRATION_SUFFIX}`),
  ];

  // Data rows: one per outlet. Value = whole points (blank when this outlet has no such field).
  // Narration cells are present but blank — the parser treats them as optional display text.
  const dataRows: (string | number)[][] = outletOrder.map((code) => {
    const byField = cell.get(code) ?? new Map<string, number>();
    const row: (string | number)[] = [code, outletName.get(code) ?? code];
    for (const f of fieldOrder) {
      const v = byField.get(f);
      row.push(v === undefined ? '' : v);
    }
    for (let i = 0; i < fieldOrder.length; i++) row.push('');
    return row;
  });

  // aoa (NOT json_to_sheet) so row 0 is the TITLE and row 1 is the header — the exact layout
  // parseCreditUpload expects (it reads headers at index 1, data at index 2+).
  const wsData: (string | number)[][] = [
    [`Credits & Payouts Data — ${monthLabel(preview.period)}`],
    headers,
    ...dataRows,
  ];

  const ws = aoaToSheetSafe(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, CREDIT_SHEET_NAME);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ─── Preview report (human review) ─────────────────────────────────────────────

/** Column headers of the "Preview Rows" sheet — stable, explicit order. */
const PREVIEW_REPORT_COLUMNS = [
  'Outlet Code',
  'Outlet Name',
  'Program',
  'KPI Code',
  'Achievement',
  'Target',
  'Status',
  'Points',
  'Reason / Explanation',
  'Rule ID',
  'Rule Version',
] as const;

/** Column headers of the "Summary" sheet. */
const PREVIEW_SUMMARY_COLUMNS = [
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
 * Build the full human-readable preview report: a "Preview Rows" sheet (one row per preview row, EVERY
 * status, with the math explanation) + a "Summary" sheet (the run's counts + total points + the
 * engine-disabled flag). This is what the operator shares with the client offline for approval before
 * re-uploading the credit-upload file.
 */
function old_buildPreviewReportXlsx(preview: ComputePreview): Buffer {
  // POINTS report: exclude PAYOUT rows (they live in the payout report). NO_RULE rows carry no award type
  // and belong here (the primary view). Keeping this symmetric with buildPayoutReportXlsx means the counts
  // reconcile — a mixed run no longer shows PAYOUT outlets as OK/blank-points with a summary that counts
  // them in OK but not in Total Points.
  const pointsRows = preview.rows.filter((r) => r.awardType !== 'PAYOUT');

  const rows: Record<string, unknown>[] = pointsRows.map((r) => ({
    'Outlet Code': r.outletCode,
    'Outlet Name': (r.outletName && r.outletName.trim()) || '',
    Program: (r.program && r.program.trim()) || '',
    'KPI Code': r.kpiCode,
    Achievement: num(r.achievement),
    Target: num(r.target),
    Status: r.status,
    // Whole points only on OK rows; blank otherwise (no points to show).
    Points: r.status === 'OK' ? num(r.points) : '',
    // SKIP/ERROR/NO_RULE carry a `reason`; OK rows carry the trace `explanation`.
    'Reason / Explanation': r.reason ?? r.explanation ?? '',
    'Rule ID': r.ruleId ?? '',
    'Rule Version': typeof r.ruleVersion === 'number' ? r.ruleVersion : '',
  }));

  // Points-only counts (the preview counts cover ALL rows, points + payout).
  const counts = { ok: 0, skip: 0, error: 0, noRule: 0 };
  for (const r of pointsRows) {
    if (r.status === 'OK') counts.ok++;
    else if (r.status === 'SKIP') counts.skip++;
    else if (r.status === 'ERROR') counts.error++;
    else counts.noRule++;
  }

  const summary: Record<string, unknown>[] = [
    {
      Client: preview.clientId,
      Period: preview.period,
      Total: pointsRows.length,
      OK: counts.ok,
      Skip: counts.skip,
      Error: counts.error,
      'No Rule': counts.noRule,
      'Total Points': preview.totalPoints,
      'Engine Disabled': preview.engineDisabled,
    },
  ];

  return buildXlsx([
    { name: 'Preview Rows', rows },
    { name: 'Summary', rows: summary },
  ]);
}

// ─── Payout report (report-only; NEVER credited) ─────────────────────────────────

/** Column headers of the "Payout Rows" sheet. */
const PAYOUT_REPORT_COLUMNS = [
  'Outlet Code',
  'Outlet Name',
  'Program',
  'KPI Code',
  'Achievement',
  'Target',
  'Status',
  'Payout (INR)',
  'Reason / Explanation',
  'Rule ID',
  'Rule Version',
] as const;

/** Column headers of the payout "Summary" sheet. */
const PAYOUT_SUMMARY_COLUMNS = [
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
 * Build the PAYOUT report the operator shares with the client offline.
 *
 * PAYOUT is COMPUTE-TO-REPORT only (owner directive 2026-10-21 — PAYOUT-COMPUTE-REPORT.md): the engine
 * never credits or pays it. This report lists every PAYOUT row (one per outlet × PAYOUT rule, every
 * status) with the computed amount in WHOLE INR on OK rows, plus a summary. After the client approves it
 * offline, the final payment status is uploaded through the existing payout flow — not here.
 *
 * Only rows whose resolved rule output is a PAYOUT award are included (the engine sets `payoutRupees` and
 * clears `points` for those). POINTS rows live in the credit-upload file + preview report, not here.
 */
function old_buildPayoutReportXlsx(preview: ComputePreview): Buffer {
  const payoutRows = preview.rows.filter((r) => r.awardType === 'PAYOUT');

  const rows: Record<string, unknown>[] = payoutRows.map((r) => ({
    'Outlet Code': r.outletCode,
    'Outlet Name': (r.outletName && r.outletName.trim()) || '',
    Program: (r.program && r.program.trim()) || '',
    'KPI Code': r.kpiCode,
    Achievement: num(r.achievement),
    Target: num(r.target),
    Status: r.status,
    // Whole INR only on OK rows; blank otherwise (no amount to pay).
    'Payout (INR)': r.status === 'OK' ? num(r.payoutRupees) : '',
    // SKIP/ERROR/NO_RULE carry a `reason`; OK rows carry the trace `explanation`.
    'Reason / Explanation': r.reason ?? r.explanation ?? '',
    'Rule ID': r.ruleId ?? '',
    'Rule Version': typeof r.ruleVersion === 'number' ? r.ruleVersion : '',
  }));

  // Payout-specific counts (the preview counts cover ALL rows, points + payout).
  const counts = { ok: 0, skip: 0, error: 0, noRule: 0 };
  for (const r of payoutRows) {
    if (r.status === 'OK') counts.ok++;
    else if (r.status === 'SKIP') counts.skip++;
    else if (r.status === 'ERROR') counts.error++;
    else counts.noRule++;
  }

  const summary: Record<string, unknown>[] = [
    {
      Client: preview.clientId,
      Period: preview.period,
      'Payout Rows': payoutRows.length,
      OK: counts.ok,
      Skip: counts.skip,
      Error: counts.error,
      'No Rule': counts.noRule,
      'Total Payout (INR)': preview.totalPayoutRupees,
    },
  ];

  return buildXlsx([
    { name: 'Payout Rows', rows },
    { name: 'Summary', rows: summary },
  ]);
}

// ═══ Fixture ═════════════════════════════════════════════════════════════════════════════════════════════════

const ADMIN = { sub: 'u1', role: 'CLIENT_ADMIN', clientId: 'bajaj', phone: '', name: 'A' } as JwtPayload;

function row(i: number, over: Partial<ComputePreviewRow> = {}): ComputePreviewRow {
  const status = (['OK', 'OK', 'OK', 'SKIP', 'ERROR', 'NO_RULE'] as const)[i % 6];
  const payout = i % 7 === 0;
  return {
    outletCode: `O${String(i % 900).padStart(4, '0')}`,
    outletName: i % 11 ? ` Shop ${i % 900} ` : i === 11 ? '=evil()' : null,
    program: i % 2 ? 'Gold' : null,
    kpiCode: i % 3 ? 'VOL' : 'FOCUS',
    ruleId: status === 'NO_RULE' ? undefined : `rule-${i % 4}`,
    ruleVersion: status === 'NO_RULE' ? undefined : (i % 3) + 1,
    awardType: status === 'NO_RULE' ? undefined : payout ? 'PAYOUT' : 'POINTS',
    fieldId: `f${i % 3}`,
    fieldName: i % 13 ? ['Monthly Points', 'Focus Points', 'Bonus'][i % 3] : undefined,
    status,
    points: status === 'OK' && !payout ? (i % 17 === 0 ? 2.5 : i * 3) : undefined,
    payoutRupees: status === 'OK' && payout ? i * 10 : undefined,
    achievement: i % 5 ? i * 1.5 : null,
    target: i % 6 ? i * 2 : Number.NaN,
    reason: status === 'OK' ? undefined : `why ${i}`,
    explanation: status === 'OK' ? `@${i} = achieved × rate` : undefined,
    ...over,
  };
}

function preview(n: number, over: Partial<ComputePreview> = {}): ComputePreview {
  return {
    clientId: 'bajaj',
    period: '2026-07',
    counts: { total: n, ok: 0, skip: 0, error: 0, noRule: 0 },
    totalPoints: 12345,
    totalPayoutRupees: 678,
    rows: Array.from({ length: n }, (_, i) => row(i)),
    engineDisabled: false,
    directCreditEnabled: false,
    ruleVersionsUsed: [],
    sourceKey: 'k',
    ...over,
  };
}

function setup(p: ComputePreview, opts: { engineEnabled?: boolean } = {}) {
  const compute = { previewCompute: jest.fn().mockResolvedValue(p) };
  const settings = { getPointsEngineFlagsUncached: jest.fn().mockResolvedValue({ enabled: opts.engineEnabled ?? true }) };
  const prisma = {
    client: { findUnique: jest.fn().mockResolvedValue({ features: {}, status: 'ACTIVE' }) },
    salesImportApply: { findFirst: jest.fn().mockResolvedValue(null) },
    salesMonthStatus: { findUnique: jest.fn().mockResolvedValue(null) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const ctx = ctxFor(ADMIN, prisma, [
    [PointsComputeService, compute],
    [TenantSettingsService, settings],
  ]);
  return { ctx, compute, settings, prisma };
}

const params = (raw: Record<string, unknown> = { period: '2026-07' }) => POINTS_PREVIEW_REPORT_KIND.parseParams(raw, ADMIN);

describe('points-* export kinds', () => {
  it('parity: credit-upload file (title row, header row, OK rows summed per outlet × field, names) — and it re-reads like the parser', async () => {
    const p = preview(3000);
    const { ctx, compute } = setup(p);
    const { buffer, rowCount } = await renderKind(POINTS_CREDIT_UPLOAD_KIND, ctx, params({ period: '2026-07', program: 'Gold', kpiCode: 'VOL' }));
    expectSameWorkbook(buffer, old_buildCreditUploadXlsx(p));
    expect(compute.previewCompute).toHaveBeenCalledWith(ADMIN, { period: '2026-07', program: 'Gold', kpiCode: 'VOL' });
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(buffer, { type: 'buffer' }).Sheets['Credits & Payouts'], { header: 1, defval: '' });
    expect(aoa[1].slice(0, 2)).toEqual(['Outlet ID', 'Outlet Name']);
    expect(rowCount).toBe(aoa.length - 2);
  });

  it('parity: preview report + payout report (Rows + Summary), formula guard, NaN/absent numbers blank', async () => {
    const p = preview(2500);
    const { ctx } = setup(p);
    const pr = await renderKind(POINTS_PREVIEW_REPORT_KIND, ctx, params());
    expectSameWorkbook(pr.buffer, old_buildPreviewReportXlsx(p));
    expect(readBook(pr.buffer).sheets['Preview Rows'].aoa.flat()).toContain("'@12 = achieved × rate");
    const po = await renderKind(POINTS_PAYOUT_REPORT_KIND, ctx, params());
    expectSameWorkbook(po.buffer, old_buildPayoutReportXlsx(p));
    expect(po.rowCount).toBe(p.rows.filter((r) => r.awardType === 'PAYOUT').length);
  });

  it('parity: empty preview → header-less row sheets + summary; empty credit file keeps title + header', async () => {
    const p = preview(0, { totalPoints: 0, totalPayoutRupees: 0, engineDisabled: true });
    const { ctx } = setup(p);
    expectSameWorkbook((await renderKind(POINTS_PREVIEW_REPORT_KIND, ctx, params())).buffer, old_buildPreviewReportXlsx(p));
    expectSameWorkbook((await renderKind(POINTS_PAYOUT_REPORT_KIND, ctx, params())).buffer, old_buildPayoutReportXlsx(p));
    expectSameWorkbook((await renderKind(POINTS_CREDIT_UPLOAD_KIND, ctx, params())).buffer, old_buildCreditUploadXlsx(p));
  });

  it('gates re-checked at build time: engine disabled → 403 (credit file only), OPEN Sales-Import month → 409; export recorded', async () => {
    const off = setup(preview(10), { engineEnabled: false });
    await expect(renderKind(POINTS_CREDIT_UPLOAD_KIND, off.ctx, params())).rejects.toThrow(new ForbiddenException(POINTS_ENGINE_DISABLED_MESSAGE));
    expect(off.compute.previewCompute).not.toHaveBeenCalled();
    await expect(renderKind(POINTS_PREVIEW_REPORT_KIND, off.ctx, params())).resolves.toBeDefined(); // report-only

    const open = setup(preview(10));
    open.prisma.client.findUnique.mockResolvedValue({ features: { salesImport: true }, status: 'ACTIVE' });
    const now = new Date();
    const current = `${now.getUTCFullYear() + 1}-01`; // a future month is OPEN (relative to now, never hardcoded)
    await expect(renderKind(POINTS_PAYOUT_REPORT_KIND, open.ctx, params({ period: current }))).rejects.toBeInstanceOf(ConflictException);
    expect(open.compute.previewCompute).not.toHaveBeenCalled();

    const ok = setup(preview(10));
    await renderKind(POINTS_PREVIEW_REPORT_KIND, ok.ctx, params());
    expect(ok.prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'EXPORT', entityType: 'SALES_MONTH', actorId: 'u1', newValues: { route: 'previewReport', period: '2026-07' } }),
    });
  });

  it('always heavy (whole-tenant compute in the worker); access, validation, names', () => {
    for (const k of [POINTS_CREDIT_UPLOAD_KIND, POINTS_PREVIEW_REPORT_KIND, POINTS_PAYOUT_REPORT_KIND]) {
      expect(k.isHeavy(params())).toBe(true);
      expect(k.access).toEqual({ roles: ['GIFSY_ADMIN', 'CLIENT_ADMIN'], permission: 'points_rules:read' });
      expect(() => k.parseParams({ period: '2026-13' }, ADMIN)).toThrow(BadRequestException);
      expect(() => k.parseParams({ period: '2026-07', other: 1 }, ADMIN)).toThrow(BadRequestException);
    }
    expect(POINTS_CREDIT_UPLOAD_KIND.fileName(params(), new Date())).toBe('points-credit-upload-2026-07.xlsx');
    expect(POINTS_PREVIEW_REPORT_KIND.fileName(params(), new Date())).toBe('points-preview-2026-07.xlsx');
    expect(POINTS_PAYOUT_REPORT_KIND.fileName(params(), new Date())).toBe('points-payout-report-2026-07.xlsx');
    expect(POINTS_PREVIEW_REPORT_KIND.describeParams(params({ period: '2026-07', program: 'Gold' }))).toBe('Jul 2026 · Gold');
    expect(SalesMonthClosedGuard).toBeDefined();
  });
});
