/**
 * targets.helpers.ts — pure, unit-testable Excel parse/validate/build helpers.
 *
 * Ported from platform/src/lib/target-excel-upload.ts, adapted for the backend:
 *  • generateTargetTemplateBuffer — returns a Buffer (not ArrayBuffer) from the
 *    tenant's KpiDef rows and an outlet roster.
 *  • parseTargetUploadBuffer — parses an uploaded .xlsx, validates against
 *    KpiDef codes + outlet roster, and returns per-outlet-per-month targetValues.
 *
 * CRITICAL contract:
 *   blank cell → key OMITTED from targetValues (not stored as 0).
 *   Only cells with a valid positive number are recorded.
 *   Numbers are stored VERBATIM — no computation.
 *
 * Both functions are free of Prisma / NestJS imports so they can be tested
 * directly without bootstrapping the DI container.
 */

import * as XLSX from 'xlsx';

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

/** Minimal outlet shape used for template generation and upload validation. */
export interface OutletLike {
  outletCode: string;
  name: string;
  outletType: string;    // outletType.code
}

// ── Row status ────────────────────────────────────────────────────────────────

export type RowStatus = 'accepted' | 'rejected_outlet' | 'rejected_kpi' | 'skipped_blank';

export interface ParsedRow {
  rowIndex: number;      // 1-based (1 = header block; data starts at 3)
  outletCode: string;
  outletName: string;
  outletType: string;
  /** month (YYYY-MM) → kpiCode → number (only non-blank cells) */
  monthTargets: Record<string, Record<string, number>>;
  status: RowStatus;
  remarks: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  /**
   * month → outletCode → { kpiCode → number }.
   * ONLY rows with status === 'accepted' and at least one non-blank KPI value.
   */
  acceptedTargets: Record<string, Record<string, Record<string, number>>>;
  summary: {
    total: number;
    accepted: number;
    rejected: number;
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

/** Current month as `YYYY-MM` (server clock). */
export function currentMonthKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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

// ── generateTargetTemplateBuffer ──────────────────────────────────────────────

/**
 * Build a downloadable .xlsx template.
 *
 * Layout:
 *   Row 1: month group header cells (e.g. "Jul '26 Target") — one per KPI per month
 *   Row 2: column headers (fixed cols + KPI labels for each month)
 *   Rows 3+: one pre-filled row per outlet (outletCode, outletName, outletType);
 *            the KPI target cells are left blank for the admin to fill in.
 *
 * @param kpis    The tenant's KpiDef rows (only enabled ones are used).
 * @param months  YYYY-MM strings, e.g. ['2026-07', '2026-08'].
 * @param outlets Outlet roster for the pre-filled rows.
 */
export function generateTargetTemplateBuffer(
  kpis: KpiDefLike[],
  months: string[],
  outlets: OutletLike[],
): Buffer {
  const enabled = getEnabledKpis(kpis);

  // ── Row 1: month group headers ──────────────────────────────────────────────
  const row1: (string | number)[] = Array(FIXED_COLS.length).fill('');
  for (const month of months) {
    const [year, mm] = month.split('-');
    const abbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][
      Number(mm) - 1
    ];
    const label = `${abbr} '${year.slice(2)} Target`;
    row1.push(label);
    for (let i = 1; i < enabled.length; i++) row1.push('');
  }

  // ── Row 2: column headers ────────────────────────────────────────────────────
  const row2: string[] = [...FIXED_COLS];
  for (let mi = 0; mi < months.length; mi++) {
    for (const kpi of enabled) row2.push(kpi.label);
  }

  // ── Data rows (pre-filled outlet info; KPI cells blank) ───────────────────
  const dataRows = outlets.map((o) => {
    const row: (string | number)[] = [o.outletCode, o.name, o.outletType];
    for (let mi = 0; mi < months.length; mi++) {
      for (let ki = 0; ki < enabled.length; ki++) row.push('');
    }
    return row;
  });

  const ws = XLSX.utils.aoa_to_sheet([row1, row2, ...dataRows]);

  // Column widths
  const colWidths: { wch: number }[] = [
    { wch: 16 }, // Outlet ID
    { wch: 24 }, // Outlet Name
    { wch: 16 }, // Outlet Type
  ];
  for (let mi = 0; mi < months.length; mi++) {
    for (const kpi of enabled) {
      colWidths.push({ wch: kpi.isPrimary ? 14 : 18 });
    }
  }
  ws['!cols'] = colWidths;

  // Merge month group header cells (row 1)
  const merges: XLSX.Range[] = [];
  let colOffset = FIXED_COLS.length;
  for (let mi = 0; mi < months.length; mi++) {
    merges.push({
      s: { r: 0, c: colOffset },
      e: { r: 0, c: colOffset + enabled.length - 1 },
    });
    colOffset += enabled.length;
  }
  ws['!merges'] = merges;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Targets');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ── buildResolvedTargetsBuffer ────────────────────────────────────────────────

/**
 * Build a "final targets" export for ONE month — a verbatim dump of the stored
 * `OutletTarget.targetValues` per outlet (NO geo-resolution / compute; the
 * no-compute model just surfaces what was uploaded). Blank cell = the KPI was
 * never configured for that outlet-month (key omitted from targetValues).
 *
 * @param month  YYYY-MM being exported.
 * @param kpis   The tenant's KpiDef rows (only enabled ones become columns).
 * @param rows   Stored OutletTarget rows for that month.
 */
export function buildResolvedTargetsBuffer(
  month: string,
  kpis: KpiDefLike[],
  rows: {
    outletCode: string;
    outletName: string | null;
    outletType: string | null;
    targetValues: unknown;
  }[],
): Buffer {
  const enabled = getEnabledKpis(kpis);
  const header: string[] = [...FIXED_COLS, ...enabled.map((k) => k.label)];

  const dataRows = rows.map((r) => {
    const vals = (r.targetValues ?? {}) as Record<string, unknown>;
    const out: (string | number)[] = [r.outletCode, r.outletName ?? '', r.outletType ?? ''];
    for (const k of enabled) {
      const v = vals[k.code];
      out.push(typeof v === 'number' ? v : ''); // blank = not configured
    }
    return out;
  });

  const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows]);
  ws['!cols'] = [
    { wch: 16 },
    { wch: 24 },
    { wch: 16 },
    ...enabled.map(() => ({ wch: 16 })),
  ];
  const wb = XLSX.utils.book_new();
  // Sheet names cap at 31 chars and disallow some punctuation — month is safe.
  XLSX.utils.book_append_sheet(wb, ws, `Final Targets ${month}`);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
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
export function parseTargetUploadBuffer(
  buffer: Buffer | ArrayBuffer,
  kpis: KpiDefLike[],
  knownOutletCodes: Set<string>,
): ParseResult {
  const enabled = getEnabledKpis(kpis);

  // label → code map (for resolving uploaded headers back to KPI codes)
  const labelToCode = new Map<string, string>();
  for (const kpi of enabled) {
    labelToCode.set(kpi.label.toLowerCase().trim(), kpi.code);
  }

  const wb = XLSX.read(buffer, { type: 'buffer' });
  if (wb.SheetNames.length === 0) {
    throw new Error('Unrecognized file: no worksheet found');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawAoa = XLSX.utils.sheet_to_json<(string | number | null | undefined)[]>(ws, {
    header: 1,
    defval: null,
  });

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

  // For each month block, map column offset → kpiCode (using row2 labels).
  // A null entry means the column label did not match any known KPI (skip silently).
  interface KpiColumn {
    offset: number;  // relative to block's startCol
    code: string;
  }
  const monthKpiCols: KpiColumn[][] = monthBlocks.map(({ startCol }) => {
    const cols: KpiColumn[] = [];
    for (let offset = 0; offset < enabled.length; offset++) {
      const ci = startCol + offset;
      if (ci >= headerRow2.length) break;
      const label = headerRow2[ci].toLowerCase().trim();
      const code = labelToCode.get(label);
      if (code) cols.push({ offset, code });
    }
    return cols;
  });

  // ── Parse data rows ─────────────────────────────────────────────────────────
  const rows: ParsedRow[] = [];
  const acceptedTargets: Record<string, Record<string, Record<string, number>>> = {};

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

    for (let bi = 0; bi < monthBlocks.length; bi++) {
      const { month, startCol } = monthBlocks[bi];
      const kpiCols = monthKpiCols[bi];
      const monthTargetMap: Record<string, number> = {};

      for (const { offset, code } of kpiCols) {
        const ci = startCol + offset;
        if (ci >= row.length) continue;
        const rawVal = row[ci];

        // CRITICAL: blank / null / undefined / empty string → omit the key
        if (rawVal === null || rawVal === undefined || String(rawVal).trim() === '') continue;

        const num =
          typeof rawVal === 'number' ? rawVal : parseFloat(String(rawVal).trim());

        // CRITICAL: only store valid finite numbers; non-numeric → omit the key
        if (!isFinite(num)) continue;

        // Store verbatim (positive, negative or zero are all valid targets)
        monthTargetMap[code] = num;
        hasAnyValue = true;
      }

      if (Object.keys(monthTargetMap).length > 0) {
        parsedRow.monthTargets[month] = monthTargetMap;
      }
    }

    if (!hasAnyValue) {
      parsedRow.status  = 'skipped_blank';
      parsedRow.remarks = 'All KPI cells blank — row skipped';
    } else {
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
    summary: { total: rows.length, accepted, rejected },
  };
}
