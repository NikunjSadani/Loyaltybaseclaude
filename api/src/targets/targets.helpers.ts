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

  // A KPI emits a "name override" column (a per-outlet custom display name) ONLY
  // when it is explicitly configured with hasNameOverride + a nameOverrideLabel.
  // KPIs without an override keep their single value column — the template /
  // parse round-trip is byte-identical for them.
  const hasOverrideCol = (k: KpiDefLike): boolean =>
    !!(k.hasNameOverride && k.nameOverrideLabel);

  // Per-month block width = one value column per enabled KPI, PLUS one extra
  // name column for each KPI that has a name override.
  const overrideCount = enabled.filter(hasOverrideCol).length;
  const blockWidth = enabled.length + overrideCount;

  // ── Row 1: month group headers ──────────────────────────────────────────────
  const row1: (string | number)[] = Array(FIXED_COLS.length).fill('');
  for (const month of months) {
    const [year, mm] = month.split('-');
    const abbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][
      Number(mm) - 1
    ];
    const label = `${abbr} '${year.slice(2)} Target`;
    row1.push(label);
    for (let i = 1; i < blockWidth; i++) row1.push('');
  }

  // ── Row 2: column headers ────────────────────────────────────────────────────
  // For each KPI emit its value-label column; immediately AFTER it (adjacent,
  // value-first) emit the nameOverrideLabel header when the KPI has an override.
  const row2: string[] = [...FIXED_COLS];
  for (let mi = 0; mi < months.length; mi++) {
    for (const kpi of enabled) {
      row2.push(kpi.label);
      if (hasOverrideCol(kpi)) row2.push(kpi.nameOverrideLabel as string);
    }
  }

  // ── Data rows (pre-filled outlet info; KPI + name cells blank) ─────────────
  const dataRows = outlets.map((o) => {
    const row: (string | number)[] = [o.outletCode, o.name, o.outletType];
    for (let mi = 0; mi < months.length; mi++) {
      for (let ci = 0; ci < blockWidth; ci++) row.push('');
    }
    return row;
  });

  const ws = XLSX.utils.aoa_to_sheet([row1, row2, ...dataRows]);

  // Column widths — mirror the value+name column layout per month block.
  const colWidths: { wch: number }[] = [
    { wch: 16 }, // Outlet ID
    { wch: 24 }, // Outlet Name
    { wch: 16 }, // Outlet Type
  ];
  for (let mi = 0; mi < months.length; mi++) {
    for (const kpi of enabled) {
      colWidths.push({ wch: kpi.isPrimary ? 14 : 18 });
      if (hasOverrideCol(kpi)) colWidths.push({ wch: 22 }); // name override column
    }
  }
  ws['!cols'] = colWidths;

  // Merge month group header cells (row 1) across the full (wider) block.
  const merges: XLSX.Range[] = [];
  let colOffset = FIXED_COLS.length;
  for (let mi = 0; mi < months.length; mi++) {
    merges.push({
      s: { r: 0, c: colOffset },
      e: { r: 0, c: colOffset + blockWidth - 1 },
    });
    colOffset += blockWidth;
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

  // CRITICAL: emit the SAME two-row month-group layout that
  // generateTargetTemplateBuffer produces, so a downloaded Final-Targets file
  // can be re-uploaded straight back through parseTargetUploadBuffer (which
  // requires row 1 = month-group headers and row 2 = fixed cols + KPI labels).
  // A single-header layout parses to 0 rows.

  // ── Row 1: month group header (one merged span for the single month) ────────
  const [year, mm] = month.split('-');
  const abbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][
    Number(mm) - 1
  ];
  const monthLabel = `${abbr} '${year.slice(2)} Target`;
  const row1: (string | number)[] = Array(FIXED_COLS.length).fill('');
  row1.push(monthLabel);
  for (let i = 1; i < enabled.length; i++) row1.push('');

  // ── Row 2: column headers ───────────────────────────────────────────────────
  const row2: string[] = [...FIXED_COLS, ...enabled.map((k) => k.label)];

  // ── Data rows (verbatim stored values; blank = KPI not configured) ──────────
  const dataRows = rows.map((r) => {
    const vals = (r.targetValues ?? {}) as Record<string, unknown>;
    const out: (string | number)[] = [r.outletCode, r.outletName ?? '', r.outletType ?? ''];
    for (const k of enabled) {
      const v = vals[k.code];
      out.push(typeof v === 'number' ? v : ''); // blank = not configured
    }
    return out;
  });

  const ws = XLSX.utils.aoa_to_sheet([row1, row2, ...dataRows]);
  ws['!cols'] = [
    { wch: 16 },
    { wch: 24 },
    { wch: 16 },
    ...enabled.map(() => ({ wch: 16 })),
  ];

  // Merge the month-group header cell across its KPI columns (row 1).
  if (enabled.length > 0) {
    ws['!merges'] = [
      {
        s: { r: 0, c: FIXED_COLS.length },
        e: { r: 0, c: FIXED_COLS.length + enabled.length - 1 },
      },
    ];
  }

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
