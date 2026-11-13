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
  const hasOverrideCol = (k: KpiDefLike): boolean => !!(k.hasNameOverride && k.nameOverrideLabel);

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
      if (hasOverrideCol(kpi)) headerRow.push(kpi.nameOverrideLabel as string);
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
  const monthRow: (string | number)[] = Array(identityCols.length).fill('');
  monthRow.push(monthGroupLabel(month));
  for (let i = 1; i < enabled.length; i++) monthRow.push('');
  return {
    // Sheet names cap at 31 chars and disallow some punctuation — month is safe.
    sheetName: `Final Targets ${month}`,
    monthRow,
    headerRow: [...identityCols, ...enabled.map((k) => k.label)],
    widths: [16, 24, 16, 20, ...enabled.map(() => 16)],
    merges: enabled.length > 0
      ? [{ s: { r: 0, c: identityCols.length }, e: { r: 0, c: identityCols.length + enabled.length - 1 } }]
      : [],
    row: (r) => {
      const vals = (r.targetValues ?? {}) as Record<string, unknown>;
      const out: (string | number)[] = [r.outletCode, r.outletName ?? '', r.outletType ?? '', r.programName ?? ''];
      for (const k of enabled) {
        const v = vals[k.code];
        out.push(typeof v === 'number' ? v : ''); // blank = not configured
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
    throw new Error('Unrecognized file: no worksheet found');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<(string | number | null | undefined)[]>(ws, {
    header: 1,
    defval: null,
  });
}

export function parseTargetUploadBuffer(
  buffer: Buffer | ArrayBuffer,
  kpis: KpiDefLike[],
  knownOutletCodes: Set<string>,
  opts?: { scope?: ParseScopeOptions },
): ParseResult {
  const scope = opts?.scope;
  let ignoredOutOfScope = 0;
  const enabled = getEnabledKpis(kpis);

  // label → code map (for resolving uploaded VALUE headers back to KPI codes)
  const labelToCode = new Map<string, string>();
  for (const kpi of enabled) {
    labelToCode.set(kpi.label.toLowerCase().trim(), kpi.code);
  }

  // nameOverrideLabel → code map (for the OPTIONAL per-outlet custom-name column
  // that sits adjacent to a KPI's value column when hasNameOverride is set). The
  // string typed under this column is stored at targetValues.__names[code].
  const overrideLabelToCode = new Map<string, string>();
  for (const kpi of enabled) {
    if (kpi.hasNameOverride && kpi.nameOverrideLabel) {
      overrideLabelToCode.set(kpi.nameOverrideLabel.toLowerCase().trim(), kpi.code);
    }
  }

  const rawAoa = readFirstSheetAoa(buffer);

  // A valid template always has the two header rows (month-group row + column
  // labels). Fewer rows means the file is not a recognizable template (e.g. a
  // non-xlsx / corrupt file XLSX salvaged into a 1-cell sheet) → reject rather
  // than silently accept an empty upload.
  if (rawAoa.length < 2) {
    throw new Error(
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
    throw new Error('Unrecognized template: missing the required "Outlet ID" column');
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
    kind: 'value' | 'name';  // 'value' = KPI target value; 'name' = override name
  }
  const monthKpiCols: KpiColumn[][] = monthBlocks.map((block, bi) => {
    const blockStart = block.startCol;
    const blockEnd =
      bi + 1 < monthBlocks.length ? monthBlocks[bi + 1].startCol : headerRow2.length;
    const cols: KpiColumn[] = [];
    const seen = new Set<string>();       // KPI value columns already matched
    const seenNames = new Set<string>();  // KPI name-override columns already matched
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
      }
      // Skip fixed columns / blanks / unknown labels.
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
      throw new Error(
        `Template KPI columns don't match the configured KPIs for "${monthBlocks[bi].month}" ` +
          `(missing: ${missing.join(', ') || '(none resolved)'}) — re-download the template`,
      );
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

        // D1 (scoped tenants only): an out-of-scope (outlet, KPI) cell is IGNORED — value and name.
        // Only a NUMERIC value counts as "ignored" (the template's `N/A` is just non-numeric).
        if (scope && !scope.isInScope(outletCode, code)) {
          if (kind === 'value') {
            const n =
              typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal).trim().replace(/,/g, ''));
            if (isFinite(n)) {
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
    summary: { total: rows.length, accepted, rejected, ignoredOutOfScope },
  };
}
