/**
 * Bajaj payout tracker — workbook writer (PURE: in → .xlsx Buffer, no DB / IO).
 *
 * Sheets (in order): Summary · retail · Ws · Exceptions (only when non-empty) · About.
 * Built with the in-memory exceljs Workbook (styles, freeze panes, auto-filter, number formats are needed; the
 * tracker is a few thousand rows, so the streaming writer in common/xlsx-stream.ts is not required).
 *
 * Cell rules: every string goes through `cellSafe` (formula-injection guard); null → empty cell; outlet /
 * distributor codes (Customer Code, SAP Code, CODE) are ALWAYS written as text (numFmt '@'), never as numbers;
 * a string in a numeric column (e.g. 'NA', '— (paid in …)') stays text.
 */
import ExcelJS from 'exceljs';
import { cellSafe } from '../../common/xlsx';
import {
  clientNoteTexts,
  RANK_WEIGHTS,
  RETAIL_COLUMNS,
  wsColumns,
  type NotBillingLine,
  type RlpLine,
  type Row,
  type TrackerInput,
  type TrackerRows,
  type TrackerSummary,
} from './payout-tracker.types';
import {
  BAND_STYLE,
  HEADER_TEXT,
  isTotalLabel,
  outletSheetSection,
  RAG_ROUND_DECIMALS,
  ragBand,
  SCALE2_COLORS,
  SCALE3_COLORS,
  SECTION_FILL,
  summarySection,
  TOTAL_FILL,
  valueRuleOf,
  colourKeyLines,
  COLOUR_KEY_INTRO,
  type Band,
  type RagRule,
  type Section,
  type ValueRule,
} from './payout-tracker.format';

export type TrackerWorkbookInput = Pick<TrackerInput, 'clientName' | 'month' | 'monthLabel' | 'salesAsOf' | 'provisional' | 'quarterLabel'> &
  Partial<Pick<TrackerInput, 'notes'>>;

// ─── Formats ───────────────────────────────────────────────────────────────────────────────────────────
export const FMT = {
  PCT: '0%',
  PCT1: '0.0%', // row ratios: 99.6% must not display as 100% when the target was missed (audit 2026-11-27)
  SCORE: '0.00',
  // Indian grouping (12,34,567) on ANY machine locale: conditional sections with QUOTED literal commas
  // (exceljs strips backslash escapes on write; quotes survive — verified in Excel 2026-11-27).
  MONEY: '[>=10000000]##","##","##","##0;[>=100000]##","##","##0;##,##0', // whole ₹ payouts / whole points
  VALUE: '[>=10000000]##","##","##","##0.00;[>=100000]##","##","##0.00;##,##0.00', // ₹ targets / achievements
  CASES: '0.00', // fractional cases to 2 decimals
  COUNT: '0',
  TEXT: '@',
} as const;

const solid = (hex: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex}` } });
const TOTAL_ROW_FILL = solid(TOTAL_FILL);
const THIN: ExcelJS.Border = { style: 'thin', color: { argb: 'FFB0B8C4' } };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const MAX_WIDTH = 40;
const MIN_WIDTH = 8;

/** Columns that hold codes — always text. */
const CODE_COLUMNS = new Set<string>(['Customer Code', 'SAP Code', 'CODE']);

const RETAIL_VALUE = new Set<string>(['Total Target', 'Total Ach', 'ADHO Target', 'ADHO Ach', 'Non ADHO Target', 'Non ADHO Ach', 'FB Target', 'FB Ach']);
const RETAIL_MONEY = new Set<string>([
  'Payout per Window', 'Potential Payout', 'Performance Payout', 'Visibility Payout', 'Line Payout', 'Total Payout',
]);
const RETAIL_COUNT = new Set<string>(['Line Target', 'Line Ach', 'WORKING', 'Approved Visibility Payout', 'ECO', 'WOA', 'Gifsy Approval']);

const WS_VALUE = new Set<string>(['Target', 'Ach']);
const WS_CASES = new Set<string>(['Total Cases', 'FB1 Cases', 'FB2 Cases']);
const WS_COUNT = new Set<string>(['Ach WOA', 'Gifsy Approval']);

function isPctHeader(h: string): boolean {
  return h.endsWith('%') || h === 'WoA' || h === 'Ach%';
}

export function retailFormat(h: string): string | null {
  if (CODE_COLUMNS.has(h)) return FMT.TEXT;
  if (isPctHeader(h)) return FMT.PCT1;
  if (RETAIL_VALUE.has(h)) return FMT.VALUE;
  if (RETAIL_MONEY.has(h)) return FMT.MONEY;
  if (RETAIL_COUNT.has(h)) return FMT.COUNT;
  return null;
}

export function wsFormat(h: string): string | null {
  if (CODE_COLUMNS.has(h)) return FMT.TEXT;
  if (isPctHeader(h)) return FMT.PCT1;
  if (WS_VALUE.has(h)) return FMT.VALUE;
  if (WS_CASES.has(h)) return FMT.CASES;
  if (WS_COUNT.has(h)) return FMT.COUNT;
  if (h.endsWith('Points') || h.startsWith('Consistency Bonus')) return FMT.MONEY;
  return null;
}

// ─── Cell helpers ──────────────────────────────────────────────────────────────────────────────────────
type Cellish = string | number | null | undefined;

/** Write one value into a cell with the column's format. Codes are forced to text. */
function setCell(cell: ExcelJS.Cell, v: Cellish, fmt: string | null): void {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) {
    if (fmt === FMT.TEXT) cell.numFmt = FMT.TEXT;
    return; // empty cell
  }
  if (fmt === FMT.TEXT) {
    cell.value = cellSafe(String(v));
    cell.numFmt = FMT.TEXT;
    return;
  }
  if (typeof v === 'number') {
    cell.value = v;
    if (fmt) cell.numFmt = fmt;
    return;
  }
  cell.value = cellSafe(v);
}

/** Header cell coloured by its section (white bold text on the section fill). */
function styleHeaderCell(cell: ExcelJS.Cell, section: Section): void {
  cell.font = { bold: true, color: { argb: `FF${HEADER_TEXT}` } };
  cell.fill = solid(SECTION_FILL[section]);
  cell.border = BORDER;
  cell.alignment = { vertical: 'middle', wrapText: true };
}

function displayLen(v: Cellish): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Math.min(String(Math.round(v * 100) / 100).length + 3, 18);
  return v.length;
}

function clampWidth(n: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.ceil(n) + 2));
}

/** Header + data sheet (retail / Ws): bold filled header, frozen, auto-filtered, sized columns. */
function writeDataSheet(
  wb: ExcelJS.Workbook,
  name: string,
  headers: readonly string[],
  rows: readonly Row[],
  formatOf: (h: string) => string | null,
  sectionOf: (h: string) => Section = outletSheetSection,
): ExcelJS.Worksheet {
  // Freeze ONLY the header row. Owner 2026-11-28: no frozen columns — freezing up to Customer Name locked too many
  // columns and made the sheets hard to navigate.
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: 0 }] });
  const widths = headers.map((h) => h.length);
  const header = ws.getRow(1);
  headers.forEach((h, i) => {
    const c = header.getCell(i + 1);
    c.value = cellSafe(h);
    styleHeaderCell(c, sectionOf(h));
  });
  // Outlet rows are deliberately plain — no conditional formatting on outlet sheets (owner 2026-11-27).
  const fmts = headers.map(formatOf);
  rows.forEach((r, ri) => {
    const row = ws.getRow(ri + 2);
    headers.forEach((h, ci) => {
      const v = r[h];
      setCell(row.getCell(ci + 1), v, fmts[ci]);
      widths[ci] = Math.max(widths[ci], displayLen(v));
    });
  });
  headers.forEach((_, i) => {
    ws.getColumn(i + 1).width = clampWidth(widths[i]);
  });
  if (headers.length > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  return ws;
}

// ─── Summary sheet ─────────────────────────────────────────────────────────────────────────────────────
export function rlpHeaders(labelHeader: string): string[] {
  return [
    labelHeader, 'Outlet Count - As approved by Gifsy', 'Outlets > 100%', 'WoA', 'Value Target', 'Value Ach', 'Ach %',
    'Outlets eligible for Visibility payout', 'Visibility attempted (Outlets)', 'Approved', 'Approved %',
    'Outlets With >100% Ach of Line', '% Outlets', 'Score', 'Rank',
  ];
}

export function notBillingHeaders(labelHeader: string): string[] {
  return [
    labelHeader, 'Outlet Count - As approved by Gifsy - Retail', 'Outlet Count - As approved by Gifsy - WS',
    'Retail on ₹0 (this month)', 'Retail %', 'WS on ₹0 (this month)', 'WS %', 'Last month ₹0 - Retail', 'Last month ₹0 - WS',
  ];
}

const RLP_FORMATS = [null, FMT.COUNT, FMT.COUNT, FMT.PCT, FMT.MONEY, FMT.MONEY, FMT.PCT, FMT.COUNT, FMT.COUNT, FMT.COUNT, FMT.PCT, FMT.COUNT, FMT.PCT, FMT.SCORE, FMT.COUNT];
const NB_FORMATS = [null, FMT.COUNT, FMT.COUNT, FMT.COUNT, FMT.PCT, FMT.COUNT, FMT.PCT, FMT.COUNT, FMT.COUNT];

/** Column index (0-based) → weight, shown on the row above the RLP header (client template). */
const RLP_WEIGHTS: Array<[number, number]> = [
  [3, RANK_WEIGHTS.woa],
  [6, RANK_WEIGHTS.ach],
  [10, RANK_WEIGHTS.visApproved],
  [12, RANK_WEIGHTS.lines],
];

function rlpValues(l: RlpLine): Cellish[] {
  return [
    l.label, l.outlets, l.outletsOver100, l.woa, l.valueTarget, l.valueAch, l.achPct, l.visEligible, l.visAttempted,
    l.visApproved, l.visApprovedPct, l.linesOver100, l.linesPct, l.score, l.rank,
  ];
}

function nbValues(l: NotBillingLine): Cellish[] {
  return [l.label, l.retailOutlets, l.wsOutlets, l.retailZero, l.retailZeroPct, l.wsZero, l.wsZeroPct, l.lmZeroRetail, l.lmZeroWs];
}

// ─── Summary conditional formatting ────────────────────────────────────────────────────────────────────
/** 1-based column → letters (1 → A, 27 → AA). */
export function colLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** Expression for one RAG band, relative to the range's top-left cell; blanks (null ratios) never match. The value
 *  is ROUNDed to the printed precision first (same as ragBand), so the colour always agrees with the shown number. */
export function ragFormula(cell: string, rule: RagRule, band: Band): string {
  const { green: g, amber: a } = rule;
  const x = `ROUND(${cell},${RAG_ROUND_DECIMALS})`;
  const cond = rule.higherIsBetter
    ? { green: `${x}>=${g}`, amber: `${x}>=${a},${x}<${g}`, red: `${x}<${a}` }
    : { green: `${x}<=${g}`, amber: `${x}>${g},${x}<=${a}`, red: `${x}>${a}` };
  return `AND(ISNUMBER(${cell}),${cond[band]})`;
}

/** Per-sheet CF priority counter (unique, ascending in write order). */
interface Prio { n: number }

function addValueFormatting(ws: ExcelJS.Worksheet, col: number, fromRow: number, toRow: number, rule: ValueRule, prio: Prio): void {
  const L = colLetter(col);
  const ref = `${L}${fromRow}:${L}${toRow}`;
  const top = `${L}${fromRow}`;
  if (rule.kind === 'rag') {
    ws.addConditionalFormatting({
      ref,
      rules: (['green', 'amber', 'red'] as const).map((band) => ({
        type: 'expression' as const,
        priority: prio.n++,
        formulae: [ragFormula(top, rule, band)],
        style: {
          fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: `FF${BAND_STYLE[band].fill}` } },
          font: { color: { argb: `FF${BAND_STYLE[band].text}` } },
        },
      })),
    });
    return;
  }
  if (rule.kind === 'scale3') {
    ws.addConditionalFormatting({
      ref,
      rules: [
        {
          type: 'colorScale',
          priority: prio.n++,
          cfvo: [
            { type: 'num', value: rule.min },
            { type: 'num', value: rule.mid },
            { type: 'num', value: rule.max },
          ],
          color: [{ argb: `FF${SCALE3_COLORS.min}` }, { argb: `FF${SCALE3_COLORS.mid}` }, { argb: `FF${SCALE3_COLORS.max}` }],
        },
      ],
    });
    return;
  }
  ws.addConditionalFormatting({
    ref,
    rules: [
      {
        type: 'colorScale',
        priority: prio.n++,
        cfvo: [{ type: 'min' }, { type: 'max' }],
        color: [{ argb: `FF${SCALE2_COLORS.min}` }, { argb: `FF${SCALE2_COLORS.max}` }],
      },
    ],
  });
}

export function provisionalLine(monthLabel: string, salesAsOf: string): string {
  return `PROVISIONAL — ${monthLabel} to date (sales up to ${salesAsOf}). Figures will change until the month is closed. Not a payment file.`;
}

export const NO_DATA_TEXT = 'No outlets in this table.';

function writeSummarySheet(wb: ExcelJS.Workbook, input: TrackerWorkbookInput, summary: TrackerSummary): void {
  const ws = wb.addWorksheet('Summary');
  const widths: number[] = [];
  const track = (ci: number, n: number) => {
    widths[ci] = Math.max(widths[ci] ?? 0, n);
  };
  let r = 1;
  const prio: Prio = { n: 1 };

  const title = ws.getCell(r, 1);
  title.value = cellSafe(`${input.clientName} — Payout Tracker — ${input.monthLabel}`);
  title.font = { bold: true, size: 14 };
  r++;
  if (input.provisional) {
    const p = ws.getCell(r, 1);
    p.value = cellSafe(provisionalLine(input.monthLabel, input.salesAsOf));
    p.font = { bold: true, color: { argb: 'FFC00000' } };
    r++;
  }
  r++; // blank row

  const table = (
    heading: string,
    headers: string[],
    lines: Cellish[][],
    formats: Array<string | null>,
    weights: Array<[number, number]> | null,
  ) => {
    const t = ws.getCell(r, 1);
    t.value = cellSafe(heading);
    t.font = { bold: true, size: 12 };
    r++;
    if (weights) {
      for (const [ci, w] of weights) {
        const c = ws.getCell(r, ci + 1);
        c.value = w;
        c.numFmt = FMT.PCT;
        c.font = { bold: true, italic: true };
        c.alignment = { horizontal: 'center' };
      }
      r++;
    }
    headers.forEach((h, ci) => {
      const c = ws.getCell(r, ci + 1);
      c.value = cellSafe(h);
      styleHeaderCell(c, summarySection(h, ci));
      track(ci, Math.min(h.length, 22)); // long headers wrap
    });
    r++;
    if (lines.length === 0) {
      const c = ws.getCell(r, 1);
      c.value = NO_DATA_TEXT;
      c.font = { italic: true };
      r++;
    }
    // Owner 2026-11-27: every RAG-coloured % column shows 1 decimal (99.6% must not read "100%" in amber).
    const cellFormats = headers.map((h, ci) => (valueRuleOf(h, ci)?.kind === 'rag' ? FMT.PCT1 : formats[ci]));
    // Runs of consecutive NON-Total data rows: conditional formatting covers these only (Totals stay plain bold).
    const runs: Array<[number, number]> = [];
    for (const vals of lines) {
      const isTotal = isTotalLabel(vals[0]);
      vals.forEach((v, ci) => {
        const c = ws.getCell(r, ci + 1);
        setCell(c, v, cellFormats[ci]);
        c.border = BORDER;
        if (isTotal) {
          c.font = { bold: true };
          c.fill = TOTAL_ROW_FILL;
        }
        track(ci, displayLen(v));
      });
      if (!isTotal) {
        const last = runs[runs.length - 1];
        if (last && last[1] === r - 1) last[1] = r;
        else runs.push([r, r]);
      }
      r++;
    }
    headers.forEach((h, ci) => {
      const rule = valueRuleOf(h, ci);
      if (!rule) return;
      for (const [from, to] of runs) {
        // A min→max scale over ONE value is meaningless (Excel would paint it the max colour; the email shows white).
        if (rule.kind === 'scale2' && to - from < 1) continue;
        addValueFormatting(ws, ci + 1, from, to, rule, prio);
      }
    });
    r++; // blank row between tables
  };

  table('1. Zone Summary - RLP', rlpHeaders('Zone'), summary.zoneRlp.map(rlpValues), RLP_FORMATS, RLP_WEIGHTS);
  table('2. Zone Summary - Outlets Not yet Started Billing', notBillingHeaders('Zone'), summary.zoneNotBilling.map(nbValues), NB_FORMATS, null);
  table('3. SM Summary - RLP', rlpHeaders('SM HQ'), summary.smRlp.map(rlpValues), RLP_FORMATS, RLP_WEIGHTS);
  table('4. SM Summary - Outlets Not yet Started Billing', notBillingHeaders('SM HQ'), summary.smNotBilling.map(nbValues), NB_FORMATS, null);
  table('5. Bottom 10 ASM HQs (by score)', rlpHeaders('ASM HQ'), summary.bottomAsm.map(rlpValues), RLP_FORMATS, RLP_WEIGHTS);

  // Column A also holds the titles; size it by the table labels only (titles overflow into empty cells).
  for (let ci = 0; ci < widths.length; ci++) ws.getColumn(ci + 1).width = clampWidth(widths[ci] ?? 0);
}

// ─── Exceptions + About ────────────────────────────────────────────────────────────────────────────────
function writeExceptionsSheet(wb: ExcelJS.Workbook, rows: TrackerRows): void {
  const data: Row[] = rows.exceptions.map((e) => ({ Code: e.code, Name: e.name, Reason: e.reason }));
  writeDataSheet(wb, 'Exceptions', ['Code', 'Name', 'Reason'], data, (h) => (h === 'Code' ? FMT.TEXT : null));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'DD MMM YYYY HH:mm IST' (IST = UTC+05:30, no DST). */
export function formatIst(d: Date): string {
  const t = new Date(d.getTime() + 330 * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(t.getUTCDate())} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())} IST`;
}

export const ABOUT_NOTES = [
  'Payouts (₹) and points are calculated by Gifsy using the programme rules in force from 1 Nov 2026.',
  'Only outlets whose KYC is currently approved by Gifsy are included.',
  'Gifsy Approval = 1 when the outlet earns a payout / points on the current figures.',
  'Ratios: Total Ach % and Line Ach % uncapped; ADHO / Non ADHO / FB Ach % capped at 120%.',
  'WoA = outlets at or above 100% of Total target ÷ outlets. ECO = outlet billed this month (Total Ach > 0). WORKING = visibility photo submitted this month.',
  'Visibility attempted = outlets that submitted a visibility photo this month (approved, pending review or rejected); Approved % = approved ÷ attempted.',
  'Score = 30% × WoA + 30% × Ach % + 20% × Approved % + 20% × % Outlets (Lines); Rank 1 = highest score.',
  'Last month ₹0 = no sales or ₹0 sales in the whole of last month.',
];

export function statusText(input: TrackerWorkbookInput): string {
  return input.provisional
    ? `PROVISIONAL — ${input.monthLabel} is still open; figures will change until the month is closed. Not a payment file.`
    : `FINAL — ${input.monthLabel} is closed.`;
}

function writeAboutSheet(wb: ExcelJS.Workbook, input: TrackerWorkbookInput, rows: TrackerRows, generatedAt: Date): void {
  const ws = wb.addWorksheet('About');
  const kv: Array<[string, string]> = [
    ['Client', input.clientName],
    ['Month', `${input.monthLabel} (${input.month})`],
    ['Status', statusText(input)],
    ['Sales up to', input.salesAsOf],
    ['Generated at', formatIst(generatedAt)],
  ];
  if (rows.exceptions.length > 0) {
    kv.push(['Exceptions', `${rows.exceptions.length} outlet(s) could not be placed on a sheet — see the Exceptions sheet.`]);
  }
  let r = 1;
  for (const [k, v] of kv) {
    const kc = ws.getCell(r, 1);
    kc.value = cellSafe(k);
    kc.font = { bold: true };
    const vc = ws.getCell(r, 2);
    vc.value = cellSafe(v);
    if (k === 'Status' && input.provisional) vc.font = { bold: true, color: { argb: 'FFC00000' } };
    r++;
  }
  r++;
  const nh = ws.getCell(r, 1);
  nh.value = 'Notes';
  nh.font = { bold: true };
  r++;
  for (const n of ABOUT_NOTES) {
    ws.getCell(r, 1).value = cellSafe(n);
    r++;
  }
  r++;
  const kh = ws.getCell(r, 1);
  kh.value = cellSafe(COLOUR_KEY_INTRO);
  kh.font = { bold: true };
  r++;
  for (const n of colourKeyLines()) {
    ws.getCell(r, 1).value = cellSafe(n);
    r++;
  }
  const dataNotes = clientNoteTexts(input.notes); // ops-only notes never reach the client file
  if (dataNotes.length) {
    r++;
    const dh = ws.getCell(r, 1);
    dh.value = 'Data notes';
    dh.font = { bold: true, color: { argb: 'FFC00000' } };
    r++;
    for (const n of dataNotes) {
      ws.getCell(r, 1).value = cellSafe(n);
      r++;
    }
  }
  ws.getColumn(1).width = 16;
  ws.getColumn(2).width = 100;
}

// ─── Entry point ───────────────────────────────────────────────────────────────────────────────────────
export async function writeTrackerWorkbook(
  input: TrackerWorkbookInput,
  rows: TrackerRows,
  summary: TrackerSummary,
  generatedAt: Date,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Gifsy';
  wb.created = generatedAt;

  writeSummarySheet(wb, input, summary);
  writeDataSheet(wb, 'retail', RETAIL_COLUMNS, rows.retail.map((x) => x.cells), retailFormat);
  writeDataSheet(wb, 'Ws', wsColumns(input.quarterLabel), rows.ws.map((x) => x.cells), wsFormat);
  if (rows.exceptions.length > 0) writeExceptionsSheet(wb, rows);
  writeAboutSheet(wb, input, rows, generatedAt);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
