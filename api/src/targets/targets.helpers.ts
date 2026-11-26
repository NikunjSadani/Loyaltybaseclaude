/**
 * targets.helpers.ts — pure, unit-testable Excel parse/validate/build helpers.
 *
 * Ported from platform/src/lib/target-excel-upload.ts, adapted for the backend:
 *  • targetTemplateLayout / resolvedTargetsLayout / salesDataLayout — the sheet
 *    layouts the target/achievement export kinds stream (exports/kinds/batch2).
 *  • parseTargetUploadBuffer — parses an uploaded .xlsx, validates against
 *    KpiDef codes + outlet roster, and returns per-outlet-per-month targetValues.
 *
 * CRITICAL contract:
 *   blank cell → key OMITTED from targetValues (not stored as 0).
 *   Only cells with a valid positive number are recorded.
 *   Numbers are stored VERBATIM — no computation.
 *
 * `__names` reserved key convention:
 *   Per-outlet custom KPI display names ("name override") are stored INSIDE the
 *   same `targetValues` JSON under a single reserved nested key `__names`, keyed
 *   by KPI code, e.g.
 *     targetValues = { "FOCUS_PACK_1": 120, "__names": { "FOCUS_PACK_1": "Diwali Combo" } }
 *   KPI VALUES stay keyed by code as before; `__names` is the ONLY non-code key.
 *   Consumers that read values by KPI code ignore `__names` automatically; any
 *   path that ENUMERATES targetValues keys as KPI codes must filter `__names` out
 *   (see NAMES_KEY below).
 *
 * Both functions are free of Prisma / NestJS imports so they can be tested
 * directly without bootstrapping the DI container.
 */

import * as XLSX from 'xlsx';
import { istMonthKey } from '../common/ist-date';
import { problemRowsEcho } from '../common/upload-echo';
import { isNumericFocusToken, splitFocusName } from '../sales-import/kpi/focus-products';

// ── Shared types ──────────────────────────────────────────────────────────────

/** Minimal KPI shape — mirrors only the columns targets.helpers.ts needs. */
export interface KpiDefLike {
  code: string;           // stable key — used as the targetValues key
  label: string;          // column header in the template
  isPrimary: boolean;
  hasNameOverride: boolean;
  nameOverrideLabel: string | null;
  order: number;
  enabled: boolean;
}

/**
 * Reserved nested key inside `targetValues` that holds per-outlet custom KPI
 * display names (the "name override"), keyed by KPI code. NEVER a KPI code.
 * Any code that iterates targetValues keys as KPI codes must skip this one.
 */
export const NAMES_KEY = '__names' as const;

/**
 * Returns the KPI-code keys of a `targetValues` JSON, EXCLUDING the reserved
 * `__names` key. Use this anywhere you would otherwise `Object.keys(targetValues)`
 * and treat each key as a KPI code.
 */
export function kpiCodeKeys(targetValues: Record<string, unknown> | null | undefined): string[] {
  if (!targetValues) return [];
  return Object.keys(targetValues).filter((k) => k !== NAMES_KEY);
}

/** Minimal outlet shape used for template generation and upload validation. */
export interface OutletLike {
  outletCode: string;
  name: string;
  outletType: string;    // outletType.code
  /** Outlet.programName — only read by a SCOPED template (APPLIES-TO D2). */
  program?: string | null;
  /** Outlet.programCategory (Sub-Program) — only read by a SCOPED template (APPLIES-TO D2). */
  subProgram?: string | null;
}

// ── APPLIES-TO scope (plan D1/D2) ─────────────────────────────────────────────

/**
 * Info columns a SCOPED template adds right after `Outlet Type` (D2). They sit before the first
 * month block, so the parser (which reads KPI columns only inside month blocks, by label) ignores
 * them on upload.
 */
export const SCOPE_INFO_COLS = ['Program', 'Sub-Program'] as const;

/** Cell text pre-filled into an out-of-scope (outlet, KPI) value cell of a scoped template (D2). */
export const OUT_OF_SCOPE_CELL = 'N/A' as const;

/**
 * Template scope hook. When passed, the template is the SCOPED layout (Program / Sub-Program
 * info columns + `N/A` in every out-of-scope value cell). When absent, the template is
 * byte-identical to the pre-APPLIES-TO layout.
 */
export interface TemplateScopeOptions {
  isInScope: (outlet: OutletLike, kpiCode: string) => boolean;
}

/**
 * Parser scope hook (D1). When passed, a numeric value in an out-of-scope (outlet, KPI) cell is
 * IGNORED (not stored), the row is kept, the row remark lists the ignored KPI codes and
 * `summary.ignoredOutOfScope` counts the ignored cells. Non-numeric cells (e.g. the template's
 * `N/A`) are ignored silently, exactly like today.
 */
export interface ParseScopeOptions {
  isInScope: (outletCode: string, kpiCode: string) => boolean;
}

/**
 * The uploaded file is not a usable template (wrong/missing header rows, no "Outlet ID" column, KPI columns that don't
 * match the configured KPIs). Its message is specific and actionable, so the upload endpoints show it as-is — unlike a
 * file SheetJS cannot read at all, which gets the generic "Invalid or corrupted xlsx file".
 */
export class TemplateFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateFormatError';
  }
}

// ── Row status ────────────────────────────────────────────────────────────────

export type RowStatus = 'accepted' | 'rejected_outlet' | 'rejected_kpi' | 'skipped_blank';

/**
 * Per-outlet-per-month value map: KPI code → number, PLUS the optional reserved
 * `__names` key (NAMES_KEY) → { kpiCode → custom display name }. The `__names`
 * sub-object is the ONLY non-numeric, non-code entry; everything else is a KPI
 * value keyed by code.
 */
export type TargetValueMap = Record<string, number | Record<string, string>>;

export interface ParsedRow {
  rowIndex: number;      // 1-based (1 = header block; data starts at 3)
  outletCode: string;
  outletName: string;
  outletType: string;
  /** month (YYYY-MM) → kpiCode → number (only non-blank cells), + optional __names */
  monthTargets: Record<string, TargetValueMap>;
  status: RowStatus;
  remarks: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  /**
   * month → outletCode → { kpiCode → number, [+ __names: { kpiCode → name }] }.
   * ONLY rows with status === 'accepted' and at least one non-blank KPI value.
   */
  acceptedTargets: Record<string, Record<string, TargetValueMap>>;
  summary: {
    total: number;
    accepted: number;
    rejected: number;
    /** Numeric values dropped because the (outlet, KPI) pair is out of the KPI's scope (D1). 0 when unscoped. */
    ignoredOutOfScope: number;
    /**
     * Only when `opts.excludedKpis` was passed: KPI code → numeric cells typed under that (excluded, e.g.
     * achievement-only) KPI's column. Those cells are never stored; the caller decides how to report them.
     */
    excludedValues?: Record<string, number>;
    /** Only with `opts.excludedKpis`: KPI code → non-blank cells typed under that excluded KPI's "<KPI> Name" column. */
    excludedNames?: Record<string, number>;
    /**
     * Only when present: name columns read from the OLD duplicate-header layout (the KPI's label written twice in a month
     * block — the 2nd occurrence is the per-outlet name). The preview / result say so.
     */
    legacyNameColumns?: Array<{ kpiCode: string; label: string; month: string; column: string }>;
    /**
     * Only with `opts.strict` and only when present: month-block columns whose header is not a KPI value / name label —
     * all their cells blank (a filled one refuses the file). The preview / result say each was ignored.
     */
    ignoredColumns?: Array<{ column: string; header: string; month: string }>;
  };
}

// ── Month parsing helper ──────────────────────────────────────────────────────

const MONTH_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** "Jul '26 Target" or "July 2026 Target" → "2026-07", or null. */
export function parseMonthHeader(raw: string): string | null {
  const normalised = raw.toLowerCase().replace(/[''`]/g, "'").trim();
  const m = normalised.match(/^([a-z]{3})[a-z]*\s+[']?(\d{2,4})\s+target$/);
  if (!m) return null;
  const monthNum = MONTH_NUM[m[1]];
  if (!monthNum) return null;
  const year = m[2].length === 2 ? `20${m[2]}` : m[2];
  return `${year}-${String(monthNum).padStart(2, '0')}`;
}

// ── Filter helpers ────────────────────────────────────────────────────────────

/** Returns only enabled KPIs sorted by order. */
export function getEnabledKpis(kpis: KpiDefLike[]): KpiDefLike[] {
  return [...kpis].filter((k) => k.enabled).sort((a, b) => a.order - b.order);
}

/** Case / surrounding-space insensitive label comparison key. */
export function labelKey(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().trim();
}

/**
 * The header of a KPI's per-outlet NAME column (template + Final Targets export), or null when the KPI has none.
 * Normally its nameOverrideLabel; when that equals the KPI's own label (Bajaj prod: FOCUS BRAND "Focus Brand 1" with
 * name label "Focus Brand 1") the sheet would show the same header twice, so the name column is "<label> Name".
 * The parser still reads the old duplicate-header layout (2nd occurrence in the month block = names).
 */
export function nameColumnHeader(k: Pick<KpiDefLike, 'label' | 'hasNameOverride' | 'nameOverrideLabel'>): string | null {
  if (!k.hasNameOverride || !k.nameOverrideLabel || k.nameOverrideLabel.trim() === '') return null;
  return labelKey(k.nameOverrideLabel) === labelKey(k.label) ? `${k.label.trim()} Name` : k.nameOverrideLabel;
}

/** 0-based column index → spreadsheet letters (0 → A, 26 → AA). */
export function columnLetter(ci: number): string {
  let n = ci + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// ── Month-lock helpers ────────────────────────────────────────────────────────

/** Current month as `YYYY-MM` (IST wall-clock; prod runs UTC). */
export function currentMonthKey(now: Date = new Date()): string {
  return istMonthKey(now);
}

/**
 * The trailing `n` months ending at (and including) the current month, oldest
 * first, as `YYYY-MM` strings. e.g. n=6 in 2026-06 → ['2026-01'..'2026-06'].
 * Used by the partner dashboard trend chart.
 */
export function lastNMonths(n: number, now: Date = new Date()): string[] {
  // Anchor on the current IST month (prod runs UTC), then step back i months on a
  // UTC anchor so month/year arithmetic is timezone-independent.
  const [cy, cm] = istMonthKey(now).split('-').map(Number); // cm is 1-based
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(cy, cm - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * A target month is LOCKED (not editable) once it is strictly in the PAST. The
 * CURRENT month stays editable (admins adjust the in-flight month); future
 * months are always editable. Strict less-than, so `YYYY-MM` string ordering
 * (which sorts chronologically) is the comparison.
 */
export function isMonthLocked(month: string, current: string = currentMonthKey()): boolean {
  return month < current;
}

// ── Fixed columns (same as the platform template) ────────────────────────────

export const FIXED_COLS = ['Outlet ID', 'Outlet Name', 'Outlet Type'] as const;

// ── Sheet layouts (template + exports) ───────────────────────────────────────────

/**
 * A two-header-row sheet: row 1 = month-group headers (merged across each month block), row 2 = column labels, rows
 * 3+ = one row per record. Written by the target/achievement export kinds (exports/kinds/batch2/targets.kinds.ts)
 * with the streaming xlsx writer — `monthRow` is the sheet's header row, `headerRow` the first data row.
 * Strings are formula-guarded (cellSafe) by the writer, exactly as aoaToSheetSafe did.
 */
export interface MonthBlockSheetLayout<R> {
  sheetName: string;
  /** Row 1: month-group headers ("Jul '26 Target"), blank over the identity columns. */
  monthRow: (string | number)[];
  /** Row 2: identity column labels + KPI labels per month block. */
  headerRow: string[];
  /** Column widths in characters (SheetJS `wch`). */
  widths: number[];
  /** Row-1 merges: each month-group header spans its block. 0-based. */
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  /** One data row for a record. */
  row(record: R): (string | number)[];
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07" → "Jul '26 Target" (the month-group header the upload parser reads back). */
function monthGroupLabel(month: string): string {
  const [year, mm] = month.split('-');
  return `${MONTH_ABBR[Number(mm) - 1]} '${year.slice(2)} Target`;
}

/**
 * The upload TEMPLATE layout (targets: many months; achievements: one month).
 *
 *   Row 1: month group header cells (e.g. "Jul '26 Target") — one per month, merged across the month block
 *   Row 2: column headers (fixed cols + KPI labels for each month)
 *   Rows 3+: one pre-filled row per outlet (outletCode, outletName, outletType); KPI cells blank for the admin.
 *
 * @param kpis    The tenant's KpiDef rows (only enabled ones are used).
 * @param months  YYYY-MM strings, e.g. ['2026-07', '2026-08'].
 * @param opts    Optional APPLIES-TO scope (D2). Absent → the pre-scope layout. Present → `Program` / `Sub-Program`
 *                info columns follow `Outlet Type` and every out-of-scope (outlet, KPI) value cell is pre-filled `N/A`.
 */
export function targetTemplateLayout(
  kpis: KpiDefLike[],
  months: string[],
  opts?: { scope?: TemplateScopeOptions },
): MonthBlockSheetLayout<OutletLike> {
  const enabled = getEnabledKpis(kpis);
  const scope = opts?.scope;
  // Identity columns: the shared FIXED_COLS, plus the D2 info columns ONLY for a scoped template.
  const fixedCols: readonly string[] = scope ? [...FIXED_COLS, ...SCOPE_INFO_COLS] : FIXED_COLS;

  // A KPI emits a "name override" column (a per-outlet custom display name) ONLY when it is explicitly configured
  // with hasNameOverride + a nameOverrideLabel. KPIs without an override keep their single value column.
  const hasOverrideCol = (k: KpiDefLike): boolean => nameColumnHeader(k) !== null;

  // Per-month block width = one value column per enabled KPI, PLUS one name column per KPI with an override.
  const overrideCount = enabled.filter(hasOverrideCol).length;
  const blockWidth = enabled.length + overrideCount;

  const monthRow: (string | number)[] = Array(fixedCols.length).fill('');
  for (const month of months) {
    monthRow.push(monthGroupLabel(month));
    for (let i = 1; i < blockWidth; i++) monthRow.push('');
  }

  // For each KPI emit its value-label column; immediately AFTER it (value-first) the nameOverrideLabel header.
  const headerRow: string[] = [...fixedCols];
  for (let mi = 0; mi < months.length; mi++) {
    for (const kpi of enabled) {
      headerRow.push(kpi.label);
      if (hasOverrideCol(kpi)) headerRow.push(nameColumnHeader(kpi) as string);
    }
  }

  const widths: number[] = [16, 24, 16]; // Outlet ID, Outlet Name, Outlet Type
  if (scope) widths.push(20, 20); // Program, Sub-Program
  for (let mi = 0; mi < months.length; mi++) {
    for (const kpi of enabled) {
      widths.push(kpi.isPrimary ? 14 : 18);
      if (hasOverrideCol(kpi)) widths.push(22); // name override column
    }
  }

  const merges: MonthBlockSheetLayout<OutletLike>['merges'] = [];
  let colOffset = fixedCols.length;
  for (let mi = 0; mi < months.length; mi++) {
    merges.push({ s: { r: 0, c: colOffset }, e: { r: 0, c: colOffset + blockWidth - 1 } });
    colOffset += blockWidth;
  }

  const row = (o: OutletLike): (string | number)[] => {
    if (scope) {
      // Scoped layout (D2): info columns + `N/A` in each out-of-scope VALUE cell. The adjacent name-override cell
      // stays blank (a typed name there is ignored on upload anyway).
      const cells: (string | number)[] = [o.outletCode, o.name, o.outletType, o.program ?? '', o.subProgram ?? ''];
      const inScope = enabled.map((k) => scope.isInScope(o, k.code));
      for (let mi = 0; mi < months.length; mi++) {
        enabled.forEach((kpi, ki) => {
          cells.push(inScope[ki] ? '' : OUT_OF_SCOPE_CELL);
          if (hasOverrideCol(kpi)) cells.push('');
        });
      }
      return cells;
    }
    const cells: (string | number)[] = [o.outletCode, o.name, o.outletType];
    for (let mi = 0; mi < months.length; mi++) {
      for (let ci = 0; ci < blockWidth; ci++) cells.push('');
    }
    return cells;
  };

  return { sheetName: 'Targets', monthRow, headerRow, widths, merges, row };
}

/** A stored OutletTarget row as the "final targets" export prints it. */
export interface ResolvedTargetRow {
  outletCode: string;
  outletName: string | null;
  outletType: string | null;
  targetValues: unknown;
  programName?: string | null;
}

/**
 * "Final targets" export for ONE month — a verbatim dump of the stored `OutletTarget.targetValues` per outlet (NO
 * compute). Blank cell = the KPI was never configured for that outlet-month (key omitted from targetValues).
 *
 * Identity columns = FIXED_COLS + a read-only "Program Name" column; then the SAME two-row month-group layout the
 * template uses, so the file re-uploads straight back through parseTargetUploadBuffer (the parser resolves fixed cols
 * by name and KPI cols by label, ignoring unknown columns).
 */
export function resolvedTargetsLayout(month: string, kpis: KpiDefLike[]): MonthBlockSheetLayout<ResolvedTargetRow> {
  const enabled = getEnabledKpis(kpis);
  const identityCols = [...FIXED_COLS, PROGRAM_NAME_COL];
  // Owner 2026-11-26: a KPI with a per-outlet name (hasNameOverride + nameOverrideLabel) gets its NAME column right
  // after its value column — same header as the template (nameColumnHeader), so the export re-uploads with the names.
  // No KPI with a name override (Deoleo) → exactly the previous layout.
  const nameHeader = new Map(enabled.map((k) => [k.code, nameColumnHeader(k)]));
  const headers: string[] = [];
  const kpiWidths: number[] = [];
  for (const k of enabled) {
    headers.push(k.label);
    kpiWidths.push(16);
    const nh = nameHeader.get(k.code);
    if (nh) {
      headers.push(nh);
      kpiWidths.push(22);
    }
  }
  const blockWidth = headers.length;
  const monthRow: (string | number)[] = Array(identityCols.length).fill('');
  monthRow.push(monthGroupLabel(month));
  for (let i = 1; i < blockWidth; i++) monthRow.push('');
  return {
    // Sheet names cap at 31 chars and disallow some punctuation — month is safe.
    sheetName: `Final Targets ${month}`,
    monthRow,
    headerRow: [...identityCols, ...headers],
    widths: [16, 24, 16, 20, ...kpiWidths],
    merges: blockWidth > 0
      ? [{ s: { r: 0, c: identityCols.length }, e: { r: 0, c: identityCols.length + blockWidth - 1 } }]
      : [],
    row: (r) => {
      const vals = (r.targetValues ?? {}) as Record<string, unknown>;
      const rawNames = vals[NAMES_KEY];
      const names = rawNames && typeof rawNames === 'object' ? (rawNames as Record<string, unknown>) : {};
      const out: (string | number)[] = [r.outletCode, r.outletName ?? '', r.outletType ?? '', r.programName ?? ''];
      for (const k of enabled) {
        const v = vals[k.code];
        out.push(typeof v === 'number' ? v : ''); // blank = not configured
        if (nameHeader.get(k.code)) {
          const n = names[k.code];
          out.push(typeof n === 'string' ? n : ''); // the writer formula-guards every string (cellSafe)
        }
      }
      return out;
    },
  };
}

/**
 * Extra identity column that the "Download Sales Data" / "Final targets" exports add and the template does NOT emit.
 * Sits AFTER the fixed identity columns and BEFORE the month block. Sourced by joining Outlet.programName.
 */
export const PROGRAM_NAME_COL = 'Program Name' as const;

/** A stored OutletSalesRecord row as the "sales data" export prints it. */
export interface SalesDataRow {
  outletCode: string;
  outletName: string | null;
  outletType: string | null;
  programName: string | null;
  kpiValues: unknown;
}

/**
 * "Sales data" export for ONE month — a verbatim dump of the stored `OutletSalesRecord.kpiValues` per outlet (NO
 * compute), in the SAME month-group 2-row layout as the template, PLUS a "Program Name" column.
 *
 * RE-UPLOAD SAFETY (hard requirement): the file must ingest cleanly back through `uploadAchievements` →
 * `parseTargetUploadBuffer`. The parser finds the fixed columns by NAME, detects month blocks from row 1, and matches
 * KPI columns by LABEL within each block's range. The Program Name column sits at index `FIXED_COLS.length` —
 * strictly BEFORE the month block — so it is never inside a block and is silently ignored on re-upload.
 */
export function salesDataLayout(month: string, kpis: KpiDefLike[]): MonthBlockSheetLayout<SalesDataRow> {
  const enabled = getEnabledKpis(kpis);
  const identityColCount = FIXED_COLS.length + 1;
  const monthRow: (string | number)[] = Array(identityColCount).fill('');
  monthRow.push(monthGroupLabel(month));
  for (let i = 1; i < enabled.length; i++) monthRow.push('');
  return {
    // Sheet names cap at 31 chars — "Sales Data 2026-07" is well under.
    sheetName: `Sales Data ${month}`,
    monthRow,
    headerRow: [...FIXED_COLS, PROGRAM_NAME_COL, ...enabled.map((k) => k.label)],
    widths: [16, 24, 16, 22, ...enabled.map(() => 16)],
    merges: enabled.length > 0
      ? [{ s: { r: 0, c: identityColCount }, e: { r: 0, c: identityColCount + enabled.length - 1 } }]
      : [],
    row: (r) => {
      const vals = (r.kpiValues ?? {}) as Record<string, unknown>;
      const out: (string | number)[] = [r.outletCode, r.outletName ?? '', r.outletType ?? '', r.programName ?? ''];
      for (const k of enabled) {
        const v = vals[k.code];
        out.push(typeof v === 'number' ? v : ''); // blank = not configured
      }
      return out;
    },
  };
}

// ── parseTargetUploadBuffer ───────────────────────────────────────────────────

/** One echoed upload row — WITHOUT its parsed KPI values (memory-safety upload echo). */
export interface UploadRowEcho {
  rowIndex: number;
  outletCode: string;
  outletName: string;
  status: RowStatus;
  remarks: string;
}

const isRejectedRow = (r: ParsedRow): boolean => r.status === 'rejected_outlet' || r.status === 'rejected_kpi';
/** A saved/skipped row whose remark the operator should read (APPLIES-TO D1 ignored values). */
const isWarningRow = (r: ParsedRow): boolean => !isRejectedRow(r) && /not applicable/i.test(r.remarks);

/**
 * Target / achievement upload response rows (memory-safety 2026-11-13). Replaces the old
 * `rows: <every parsed row incl. its KPI values>` (~1.8 MB for 6,500 rows):
 *  - problemRows  — REJECTED rows (unknown outlet / bad KPI), capped at 500, with the true total;
 *  - warningRows  — saved rows carrying an "ignored, KPI not applicable" remark, capped at 500;
 *  - skippedBlankCount — rows left blank in the template (normal; counted, not echoed).
 */
export function targetUploadRowsEcho(rows: readonly ParsedRow[]): {
  problemRows: UploadRowEcho[];
  problemRowCount: number;
  problemRowsTruncated: boolean;
  warningRows: UploadRowEcho[];
  warningRowCount: number;
  warningRowsTruncated: boolean;
  skippedBlankCount: number;
} {
  const slim = (r: ParsedRow): UploadRowEcho => ({
    rowIndex: r.rowIndex,
    outletCode: r.outletCode,
    outletName: r.outletName,
    status: r.status,
    remarks: r.remarks,
  });
  const rejected = problemRowsEcho(rows, isRejectedRow);
  const warnings = problemRowsEcho(rows, isWarningRow);
  let skippedBlankCount = 0;
  for (const r of rows) if (r.status === 'skipped_blank') skippedBlankCount++;
  return {
    problemRows: rejected.problemRows.map(slim),
    problemRowCount: rejected.problemRowCount,
    problemRowsTruncated: rejected.problemRowsTruncated,
    warningRows: warnings.problemRows.map(slim),
    warningRowCount: warnings.problemRowCount,
    warningRowsTruncated: warnings.problemRowsTruncated,
    skippedBlankCount,
  };
}

/**
 * First worksheet as an array-of-arrays. Memory-safety (2026-11-13): the SheetJS workbook
 * (the largest structure of the whole parse — every cell object + its address key) lives
 * only inside this function, so it is collectable as soon as the AoA exists instead of
 * staying reachable for the whole row loop of the caller.
 */
function readFirstSheetAoa(buffer: Buffer | ArrayBuffer): (string | number | null | undefined)[][] {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  if (wb.SheetNames.length === 0) {
    throw new TemplateFormatError('Unrecognized file: no worksheet found');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<(string | number | null | undefined)[]>(ws, {
    header: 1,
    defval: null,
  });
}

/**
 * Parse an uploaded .xlsx target file.
 *
 * Expects the same layout as generateTargetTemplateBuffer:
 *   Row 1: month group headers ("Jul '26 Target" etc.)
 *   Row 2: column labels (fixed + KPI labels per month)
 *   Row 3+: data rows
 *
 * Blank cell contract (CRITICAL):
 *   A blank / empty cell is treated as "not configured" — the corresponding
 *   kpiCode key is OMITTED from targetValues entirely (not stored as 0).
 *   Only cells that parse to a valid finite number are recorded.
 *   Numbers are stored verbatim — NO rounding, NO computation.
 *
 * Validation:
 *   • outletCode must be in knownOutletCodes → else status = 'rejected_outlet'
 *   • KPI labels in the header must resolve to known codes → unknown labels are
 *     silently skipped (the template only emits known labels; extra user columns
 *     are ignored rather than failing the whole upload)
 *
 * @param buffer           Raw xlsx file bytes.
 * @param kpis             Enabled KpiDef rows for the tenant.
 * @param knownOutletCodes Set of valid outlet codes for the tenant.
 */
export function parseTargetUploadBuffer(
  buffer: Buffer | ArrayBuffer,
  kpis: KpiDefLike[],
  knownOutletCodes: Set<string>,
  opts?: {
    scope?: ParseScopeOptions;
    /**
     * KPIs that exist but take NO values from this file (achievement-only KPIs on a target upload). Their columns are
     * optional (a file without them is complete), never stored, and their numeric cells are counted in
     * `summary.excludedValues` so the caller can refuse/report them — never silently dropped.
     */
    excludedKpis?: KpiDefLike[];
    /**
     * TARGET upload (owner no-silent rule, 2026-11-26): text in a KPI VALUE cell rejects the row with the reason (it is
     * never dropped, and "12abc" is never read as 12); an unrecognised month-block header is reported, and refuses the
     * file when its column has any filled cell; text under an excluded / out-of-scope column counts like a number.
     * Absent (achievement upload) → the previous behaviour.
     */
    strict?: boolean;
  },
): ParseResult {
  const strict = opts?.strict === true;
  const scope = opts?.scope;
  let ignoredOutOfScope = 0;
  const enabled = getEnabledKpis(kpis);
  const excludedLabelToCode = new Map<string, string>();
  const excludedNameLabelToCode = new Map<string, string>();
  for (const k of opts?.excludedKpis ?? []) {
    excludedLabelToCode.set(k.label.toLowerCase().trim(), k.code);
    if (k.hasNameOverride && k.nameOverrideLabel) {
      excludedNameLabelToCode.set(k.nameOverrideLabel.toLowerCase().trim(), k.code);
      excludedNameLabelToCode.set(labelKey(nameColumnHeader(k)), k.code);
    }
  }
  const excludedValues: Record<string, number> = {};
  const excludedNames: Record<string, number> = {};

  // label → code map (for resolving uploaded VALUE headers back to KPI codes)
  const labelToCode = new Map<string, string>();
  for (const kpi of enabled) {
    labelToCode.set(kpi.label.toLowerCase().trim(), kpi.code);
  }

  // nameOverrideLabel → code map (for the OPTIONAL per-outlet custom-name column
  // that sits adjacent to a KPI's value column when hasNameOverride is set). The
  // string typed under this column is stored at targetValues.__names[code].
  const overrideLabelToCode = new Map<string, string>();
  // KPIs whose nameOverrideLabel equals their own label (the old duplicate-header layout is possible for them).
  const duplicateLabelCodes = new Set<string>();
  for (const kpi of enabled) {
    if (kpi.hasNameOverride && kpi.nameOverrideLabel) {
      // The legacy header (the nameOverrideLabel itself) AND the current one ("<label> Name" when they collide).
      overrideLabelToCode.set(kpi.nameOverrideLabel.toLowerCase().trim(), kpi.code);
      overrideLabelToCode.set(labelKey(nameColumnHeader(kpi)), kpi.code);
      if (labelKey(kpi.nameOverrideLabel) === labelKey(kpi.label)) duplicateLabelCodes.add(kpi.code);
    }
  }
  const legacyNameColumns: Array<{ kpiCode: string; label: string; month: string; column: string }> = [];
  /** Per month block (strict): headers that are no KPI value / name label and no fixed column. */
  const unknownCols: Array<Array<{ ci: number; header: string }>> = [];
  const FIXED_LABELS = new Set([...FIXED_COLS, ...SCOPE_INFO_COLS, PROGRAM_NAME_COL].map((c) => c.toLowerCase()));
  /** Per month block: the KPIs read from the old duplicate-header layout — [value column, name column]. */
  const legacyPairs: Array<Array<{ code: string; valueCol: number; nameCol: number }>> = [];

  const rawAoa = readFirstSheetAoa(buffer);

  // A valid template always has the two header rows (month-group row + column
  // labels). Fewer rows means the file is not a recognizable template (e.g. a
  // non-xlsx / corrupt file XLSX salvaged into a 1-cell sheet) → reject rather
  // than silently accept an empty upload.
  if (rawAoa.length < 2) {
    throw new TemplateFormatError(
      'Unrecognized file: expected the target/achievement template (missing header rows)',
    );
  }

  const headerRow1 = (rawAoa[0] as (string | number | null)[]).map((c) =>
    String(c ?? '').trim(),
  );
  const headerRow2 = (rawAoa[1] as (string | number | null)[]).map((c) =>
    String(c ?? '').trim(),
  );

  // ── Find fixed column positions ─────────────────────────────────────────────
  const idxOf = (label: string) => headerRow2.indexOf(label);
  const outletIdCol   = idxOf('Outlet ID');
  const outletNameCol = idxOf('Outlet Name');
  const outletTypeCol = idxOf('Outlet Type');

  // "Outlet ID" is a mandatory template column; its absence means the uploaded
  // file is not the expected template → reject.
  if (outletIdCol === -1) {
    throw new TemplateFormatError('Unrecognized template: missing the required "Outlet ID" column');
  }

  // ── Detect month blocks from row 1 ─────────────────────────────────────────
  interface MonthBlock {
    month: string;       // YYYY-MM
    startCol: number;
  }
  const monthBlocks: MonthBlock[] = [];
  for (let ci = 0; ci < headerRow1.length; ci++) {
    const parsed = parseMonthHeader(headerRow1[ci]);
    if (parsed) {
      monthBlocks.push({ month: parsed, startCol: ci });
    }
  }

  // For each month block, map each KPI to its ABSOLUTE row-2 column index by
  // matching the row-2 header NAME — NOT by `startCol + offset`.
  //
  // Why: the row-1 month-group header is a merged span; its anchor column can
  // drift relative to the row-2 KPI block when Excel re-saves, a column is
  // inserted, or the merge shifts. A positional `startCol + offset` window then
  // slides and every value lands on the WRONG KpiDef (exposed when a KPI cell is
  // blank — values jump to neighbouring KPIs). Matching by name is both
  // order-independent (KPIs may appear in any order within the block) and
  // drift-immune (the row-1 anchor offset no longer matters).
  //
  // A KPI column is assigned to the month block whose column range contains it:
  //   block.startCol <= colIndex < nextBlock.startCol  (end-of-row for the last).
  interface KpiColumn {
    colIndex: number;  // ABSOLUTE row-2 column index
    code: string;
    // 'value' = KPI target value; 'name' = override name; 'excluded' / 'excludedName' = an opts.excludedKpis value / name column
    kind: 'value' | 'name' | 'excluded' | 'excludedName';
  }
  const monthKpiCols: KpiColumn[][] = monthBlocks.map((block, bi) => {
    const blockStart = block.startCol;
    const blockEnd =
      bi + 1 < monthBlocks.length ? monthBlocks[bi + 1].startCol : headerRow2.length;
    const cols: KpiColumn[] = [];
    const seen = new Set<string>();       // KPI value columns already matched
    const seenNames = new Set<string>();  // KPI name-override columns already matched
    const seenExcluded = new Set<string>();
    const pairs: Array<{ code: string; valueCol: number; nameCol: number }> = [];
    legacyPairs.push(pairs);
    const unknown: Array<{ ci: number; header: string }> = [];
    unknownCols.push(unknown);
    for (let ci = blockStart; ci < blockEnd && ci < headerRow2.length; ci++) {
      const label = headerRow2[ci].toLowerCase().trim();
      // Match KPI VALUE labels FIRST, override labels SECOND, so a string that is
      // both a KPI label and a nameOverrideLabel can never be confused.
      const code = labelToCode.get(label);
      if (code && !seen.has(code)) {
        seen.add(code);
        cols.push({ colIndex: ci, code, kind: 'value' });
        continue;
      }
      // Otherwise, this may be a per-outlet name-override column for a KPI.
      const nameCode = overrideLabelToCode.get(label);
      if (nameCode && !seenNames.has(nameCode)) {
        seenNames.add(nameCode);
        cols.push({ colIndex: ci, code: nameCode, kind: 'name' });
        // OLD duplicate-header layout: this header is the KPI's own label written a 2nd time → read as its names.
        if (duplicateLabelCodes.has(nameCode) && labelToCode.get(label) === nameCode) {
          const kpi = enabled.find((k) => k.code === nameCode)!;
          const valueCol = cols.find((c) => c.kind === 'value' && c.code === nameCode)!.colIndex;
          pairs.push({ code: nameCode, valueCol, nameCol: ci });
          legacyNameColumns.push({ kpiCode: nameCode, label: kpi.label, month: block.month, column: columnLetter(ci) });
        }
        continue;
      }
      // An excluded KPI's column (e.g. achievement-only on a target upload): read only to count typed values. Its
      // label written a 2nd time (old duplicate-header layout) is its NAME column.
      const excludedCode = excludedLabelToCode.get(label);
      if (excludedCode && seenExcluded.has(excludedCode) && excludedNameLabelToCode.get(label) === excludedCode) {
        cols.push({ colIndex: ci, code: excludedCode, kind: 'excludedName' });
        continue;
      }
      if (excludedCode) seenExcluded.add(excludedCode);
      if (excludedCode) {
        cols.push({ colIndex: ci, code: excludedCode, kind: 'excluded' });
        continue;
      }
      const excludedNameCode = excludedNameLabelToCode.get(label);
      if (excludedNameCode) {
        cols.push({ colIndex: ci, code: excludedNameCode, kind: 'excludedName' });
        continue;
      }
      // Skip fixed columns / blanks; an unknown label is collected (strict) — reported, or refused when filled.
      if (strict && label !== '' && !FIXED_LABELS.has(label)) unknown.push({ ci, header: headerRow2[ci] });
    }
    return cols;
  });

  // ── Integrity guard ─────────────────────────────────────────────────────────
  // Target/achievement data is too sensitive to accept a partial/ambiguous
  // column match: silently storing values against the wrong KpiDef corrupts the
  // dataset. If a month block resolves ZERO KPI columns, or the set of
  // name-matched codes does not cover the enabled KPIs for that block, reject the
  // whole file rather than persist shifted/partial data.
  const enabledCodes = enabled.map((k) => k.code);
  for (let bi = 0; bi < monthBlocks.length; bi++) {
    // Only VALUE columns count toward KPI coverage; name-override columns are
    // optional and must not affect the "all KPIs present" integrity guard.
    const matchedCodes = new Set(
      monthKpiCols[bi].filter((c) => c.kind === 'value').map((c) => c.code),
    );
    const missing = enabledCodes.filter((code) => !matchedCodes.has(code));
    if (matchedCodes.size === 0 || missing.length > 0) {
      throw new TemplateFormatError(
        `Template KPI columns don't match the configured KPIs for "${monthBlocks[bi].month}" ` +
          `(missing: ${missing.join(', ') || '(none resolved)'}) — re-download the template`,
      );
    }
  }

  // ── Unrecognised month-block columns (strict) ──────────────────────────────
  // Never silent: a filled one refuses the file (its cells would be dropped); an empty one is reported as ignored.
  const ignoredColumns: Array<{ column: string; header: string; month: string }> = [];
  if (strict) {
    const filled: string[] = [];
    for (let bi = 0; bi < monthBlocks.length; bi++) {
      for (const u of unknownCols[bi] ?? []) {
        let n = 0;
        for (let ri = 2; ri < rawAoa.length; ri++) {
          const v = ((rawAoa[ri] ?? []) as unknown[])[u.ci];
          if (!(v === null || v === undefined || String(v).trim() === '')) n++;
        }
        const where = `column ${columnLetter(u.ci)} "${u.header}" (${headerRow1[monthBlocks[bi].startCol]})`;
        if (n > 0) filled.push(`${where} — ${n} filled cell${n === 1 ? '' : 's'}`);
        else ignoredColumns.push({ column: columnLetter(u.ci), header: u.header, month: monthBlocks[bi].month });
      }
    }
    if (filled.length > 0) {
      throw new TemplateFormatError(
        `${filled.length === 1 ? 'A column was' : `${filled.length} columns were`} not recognised, so ${filled.length === 1 ? 'its' : 'their'} ` +
          `values would be ignored: ${filled.join('; ')}. The heading is not a KPI (or KPI name) column of this ` +
          'month block, or it appears more times than expected — re-download the template and copy the values into it',
      );
    }
  }

  // ── Swapped columns in the OLD duplicate-header layout ─────────────────────
  // Both columns carry the same header, so only their order says which is which. If the 1st (read as the target) holds
  // text and the 2nd (read as the names) holds only numbers, they were swapped: refuse rather than store names as
  // targets / numbers as names.
  const strictNumber = (v: unknown): boolean => {
    if (typeof v === 'number') return Number.isFinite(v);
    const t = String(v ?? '').trim().replace(/,/g, '');
    return t !== '' && Number.isFinite(Number(t));
  };
  const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
  for (let bi = 0; bi < monthBlocks.length; bi++) {
    for (const p of legacyPairs[bi]) {
      let valueText = 0;
      let nameNonBlank = 0;
      let nameNumeric = 0;
      let textSample = '';
      for (let ri = 2; ri < rawAoa.length; ri++) {
        const row = (rawAoa[ri] ?? []) as unknown[];
        const v = row[p.valueCol];
        if (!isBlank(v) && String(v).trim().toUpperCase() !== OUT_OF_SCOPE_CELL.toUpperCase() && !strictNumber(v)) {
          valueText++;
          if (!textSample) textSample = String(v).trim();
        }
        const n = row[p.nameCol];
        if (!isBlank(n)) {
          nameNonBlank++;
          if (strictNumber(n)) nameNumeric++;
        }
      }
      if (valueText > 0 && nameNonBlank > 0 && nameNumeric === nameNonBlank) {
        const kpi = enabled.find((k) => k.code === p.code)!;
        const header = headerRow2[p.valueCol];
        throw new TemplateFormatError(
          `In the "${headerRow1[monthBlocks[bi].startCol]}" block the two "${header}" columns look swapped: column ` +
            `${columnLetter(p.valueCol)} (read as the ${kpi.label} target) has text such as "${textSample}" and column ` +
            `${columnLetter(p.nameCol)} (read as the ${kpi.label} names) has only numbers. In this old layout the FIRST ` +
            `"${header}" column is the target and the SECOND is the product names — swap them, or download the current ` +
            `template (its name column is "${nameColumnHeader(kpi)}")`,
        );
      }
    }
  }

  // ── Parse data rows ─────────────────────────────────────────────────────────
  const rows: ParsedRow[] = [];
  const acceptedTargets: Record<string, Record<string, TargetValueMap>> = {};

  for (let ri = 2; ri < rawAoa.length; ri++) {
    const row = rawAoa[ri] as (string | number | null | undefined)[];
    if (!row || row.every((c) => c === null || c === undefined || String(c).trim() === ''))
      continue;

    const str = (ci: number) => String(row[ci] ?? '').trim();

    const outletCode = outletIdCol >= 0 ? str(outletIdCol) : '';
    if (!outletCode) continue;  // skip truly empty rows

    const outletName = outletNameCol >= 0 ? str(outletNameCol) : '';
    const outletType = outletTypeCol >= 0 ? str(outletTypeCol) : '';

    const parsedRow: ParsedRow = {
      rowIndex: ri + 1,  // 1-based for user messages
      outletCode,
      outletName,
      outletType,
      monthTargets: {},
      status: 'accepted',
      remarks: '',
    };

    // ── Validate outlet ───────────────────────────────────────────────────────
    if (!knownOutletCodes.has(outletCode)) {
      parsedRow.status  = 'rejected_outlet';
      parsedRow.remarks = `Outlet code "${outletCode}" not found — row rejected`;
      rows.push(parsedRow);
      continue;
    }

    // ── Read KPI values per month block ───────────────────────────────────────
    let hasAnyValue = false;
    /** strict: "Focus Brand 1 target must be a number — got 'R3TEST Brand'" per bad value cell → the row is rejected. */
    const cellErrors: string[] = [];
    // D1: KPI codes whose numeric value was ignored for this row (out of the KPI's scope).
    const ignoredCodes = new Set<string>();

    for (let bi = 0; bi < monthBlocks.length; bi++) {
      const { month } = monthBlocks[bi];
      const kpiCols = monthKpiCols[bi];
      const monthTargetMap: TargetValueMap = {};
      // Per-outlet custom names collected from the override-NAME columns. Stored
      // under the reserved `__names` key only if non-empty (never `{}`).
      const nameMap: Record<string, string> = {};

      for (const { colIndex, code, kind } of kpiCols) {
        const ci = colIndex; // ABSOLUTE column — drift-immune, order-independent
        if (ci >= row.length) continue;
        const rawVal = row[ci];

        // CRITICAL: blank / null / undefined / empty string → omit the key
        if (rawVal === null || rawVal === undefined || String(rawVal).trim() === '') continue;

        const naCell = String(rawVal).trim().toUpperCase() === OUT_OF_SCOPE_CELL.toUpperCase();
        if (kind === 'excluded') {
          const n = typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal).trim().replace(/,/g, ''));
          // strict: ANY typed entry (text too, never the template's N/A) counts — it would be dropped otherwise.
          if (isFinite(n) || (strict && !naCell)) excludedValues[code] = (excludedValues[code] ?? 0) + 1;
          continue;
        }
        if (kind === 'excludedName') {
          // Any non-blank text (blank already skipped above) — a custom name typed for a KPI that takes none here.
          excludedNames[code] = (excludedNames[code] ?? 0) + 1;
          continue;
        }

        // D1 (scoped tenants only): an out-of-scope (outlet, KPI) cell is IGNORED — value and name.
        // Only a NUMERIC value counts as "ignored" (the template's `N/A` is just non-numeric).
        if (scope && !scope.isInScope(outletCode, code)) {
          if (kind === 'value') {
            const n =
              typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal).trim().replace(/,/g, ''));
            if (isFinite(n) || (strict && !naCell)) {
              ignoredCodes.add(code);
              ignoredOutOfScope++;
            }
          }
          continue;
        }

        if (kind === 'name') {
          // Override-name column: a free-text per-outlet display name. SheetJS may
          // return a number for a numeric-looking name → coerce to a trimmed
          // string. Blank already skipped above; non-blank → store under __names.
          const name = String(rawVal ?? '').trim();
          if (name) nameMap[code] = name;
          continue;
        }

        // Locale-aware: India/en-IN uses commas as thousands separators
        // ("1,23,456.78"). Strip grouping commas before parseFloat so "1,234"
        // becomes 1234 — NOT 1 (parseFloat stops at the first comma). The "."
        // decimal separator is preserved.
        const num =
          typeof rawVal === 'number'
            ? rawVal
            : parseFloat(String(rawVal).trim().replace(/,/g, ''));

        if (strict) {
          // Whole-cell number only ("1,23,456.78" ok; "12abc" / "1011.2697 & ADHO500" are NOT 12 / 1011.2697).
          // The template's N/A marker reads as blank.
          if (naCell) continue;
          const exact = typeof rawVal === 'number' ? rawVal : Number(String(rawVal).trim().replace(/,/g, ''));
          if (!Number.isFinite(exact)) {
            const kpiLabel = enabled.find((k) => k.code === code)?.label ?? code;
            const shown = String(rawVal).trim();
            cellErrors.push(
              `${kpiLabel} target must be a number — got '${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown}'` +
                (monthBlocks.length > 1 ? ` (${headerRow1[monthBlocks[bi].startCol]})` : ''),
            );
            continue;
          }
          monthTargetMap[code] = exact;
          hasAnyValue = true;
          continue;
        }

        // CRITICAL: only store valid finite numbers; non-numeric → omit the key
        if (!isFinite(num)) continue;

        // Store verbatim (positive, negative or zero are all valid targets)
        monthTargetMap[code] = num;
        hasAnyValue = true;
      }

      // Attach collected custom names under the reserved `__names` key. Omit the
      // key entirely when empty (never store `{}`). Names ride along with the
      // month's values; they are only meaningful when there ARE values, so only
      // store them on a block that has at least one numeric value.
      if (Object.keys(monthTargetMap).length > 0) {
        if (Object.keys(nameMap).length > 0) {
          monthTargetMap[NAMES_KEY] = nameMap;
        }
        parsedRow.monthTargets[month] = monthTargetMap;
      }
    }

    if (cellErrors.length > 0) {
      // NO SILENT DROP: the row is rejected (none of its values saved) and listed with every reason.
      parsedRow.status = 'rejected_kpi';
      parsedRow.remarks = `${cellErrors.join('; ')} — row rejected`;
      parsedRow.monthTargets = {};
      rows.push(parsedRow);
      continue;
    }

    const ignoredRemark =
      ignoredCodes.size > 0
        ? `Ignored value(s) for KPI(s) not applicable to this outlet: ${[...ignoredCodes].join(', ')}`
        : '';
    if (!hasAnyValue) {
      parsedRow.status  = 'skipped_blank';
      parsedRow.remarks = ignoredRemark
        ? `No applicable KPI values — row skipped. ${ignoredRemark}`
        : 'All KPI cells blank — row skipped';
    } else {
      if (ignoredRemark) parsedRow.remarks = ignoredRemark;
      // Merge into acceptedTargets
      for (const [month, kpiMap] of Object.entries(parsedRow.monthTargets)) {
        if (!acceptedTargets[month]) acceptedTargets[month] = {};
        acceptedTargets[month][outletCode] = kpiMap;
      }
    }

    rows.push(parsedRow);
  }

  const accepted = rows.filter((r) => r.status === 'accepted').length;
  const rejected = rows.filter((r) => r.status === 'rejected_outlet' || r.status === 'rejected_kpi').length;

  return {
    rows,
    acceptedTargets,
    summary: {
      total: rows.length,
      accepted,
      rejected,
      ignoredOutOfScope,
      ...(opts?.excludedKpis ? { excludedValues, excludedNames } : {}),
      ...(legacyNameColumns.length > 0 ? { legacyNameColumns } : {}),
      ...(ignoredColumns.length > 0 ? { ignoredColumns } : {}),
    },
  };
}

// ── Focus product names that are numbers (owner 2026-11-26) ──────────────────

/** One focus-name part that is only a number: which outlet, month and column, and the value as written. */
export interface NumericFocusName {
  outletCode: string;
  month: string;
  /** The template column the name was typed in (e.g. "Focus Brand 1 Name"). */
  column: string;
  /** The number part, e.g. "1011.2697". */
  value: string;
  /** The whole name as written, e.g. "1011.2697 & ADHO500". */
  name: string;
}

/**
 * Every part of a FOCUS product name (KPI codes in `focusNameCodes` — the names Sales Import reads as products) that is
 * only a number, split exactly the way Sales Import splits names. Sorted by month, outlet, column. Pure.
 */
export function findNumericFocusNames(
  acceptedTargets: ParseResult['acceptedTargets'],
  focusNameCodes: ReadonlySet<string>,
  columnOf: (kpiCode: string) => string,
): NumericFocusName[] {
  const out: NumericFocusName[] = [];
  if (focusNameCodes.size === 0) return out;
  for (const [month, outlets] of Object.entries(acceptedTargets)) {
    for (const [outletCode, map] of Object.entries(outlets)) {
      const names = map[NAMES_KEY];
      if (!names || typeof names !== 'object') continue;
      for (const [code, raw] of Object.entries(names as Record<string, string>)) {
        if (!focusNameCodes.has(code)) continue;
        const name = String(raw ?? '');
        for (const part of splitFocusName(name)) {
          if (isNumericFocusToken(part)) out.push({ outletCode, month, column: columnOf(code), value: part, name });
        }
      }
    }
  }
  const c = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort((a, b) => c(a.month, b.month) || c(a.outletCode, b.outletCode) || c(a.column, b.column) || c(a.value, b.value));
}
