/**
 * Bajaj payout tracker — email renderer (PURE: no IO).
 *
 * renderTrackerEmail(meta, summary) → { subject, html, text }
 *  - html: complete document, ALL CSS inline (Gmail strips <style>), no images / external resources / JS.
 *    Each table is wrapped in an overflow-x:auto div so phones scroll sideways (Outlook desktop ignores it).
 *  - text: plain-text fallback with the same headline and pipe-separated tables.
 *
 * Formatting: counts / ₹ = Indian digit grouping, no decimals; ratios (fractions) = whole %; score = 2-decimal %
 * (0.84321 → '84.32%'); null / non-finite → '–'. ALL dynamic text is HTML-escaped.
 */
import { clientNoteTexts, type NotBillingLine, type RlpLine, type TrackerInput, type TrackerSummary } from './payout-tracker.types';
import {
  BAND_STYLE,
  BODY_TEXT,
  COLOUR_KEY_INTRO,
  colourKeyLines,
  HEADER_TEXT,
  isTotalLabel,
  ragBand,
  scale2Color,
  scale3Color,
  SECTION_FILL,
  summarySection,
  TOTAL_FILL,
  valueRuleOf,
} from './payout-tracker.format';

export type TrackerEmailMeta = Pick<TrackerInput, 'clientName' | 'monthLabel' | 'salesAsOf' | 'provisional'> &
  Partial<Pick<TrackerInput, 'notes'>>;

export const DATA_NOTES_HEADING = 'Data notes';

/** CLIENT notes only — ops-only notes go to the ops heads-up email, never to the client. */
function dataNotesOf(meta: TrackerEmailMeta): string[] {
  return clientNoteTexts(meta.notes);
}

const DASH = '–';

// ─── formatting ────────────────────────────────────────────────────────────────────────────────────────
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Indian digit grouping, rounded to whole: 12345678 → '1,23,45,678'. */
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return DASH;
  const r = Math.round(n);
  const neg = r < 0;
  const digits = String(Math.abs(r));
  let out: string;
  if (digits.length <= 3) {
    out = digits;
  } else {
    const last3 = digits.slice(-3);
    let rest = digits.slice(0, -3);
    const groups: string[] = [];
    while (rest.length > 2) {
      groups.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest) groups.unshift(rest);
    out = `${groups.join(',')},${last3}`;
  }
  return neg ? `-${out}` : out;
}

export function fmtMoney(n: number | null | undefined): string {
  const s = fmtInt(n);
  if (s === DASH) return DASH;
  return s.startsWith('-') ? `-₹${s.slice(1)}` : `₹${s}`;
}

/** Fraction → whole %: 1.17 → '117%'. */
export function fmtPct(f: number | null | undefined): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return DASH;
  return `${Math.round(f * 100)}%`;
}

/** Fraction → 1-decimal % for the value-coloured ratio columns: 0.996 → '99.6%' (owner 2026-11-27). */
export function fmtPct1(f: number | null | undefined): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return DASH;
  return `${(Math.round(f * 1000) / 10).toFixed(1)}%`;
}

/** Score (weighted 0–1) → 2 decimals: 0.84321 → '0.84' — the same as the Excel Summary (not a %, so it isn't
 *  mistaken for an achievement figure; audit 2026-11-27). */
export function fmtScore(f: number | null | undefined): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return DASH;
  return f.toFixed(2);
}

// ─── table model ───────────────────────────────────────────────────────────────────────────────────────
interface TableSpec {
  title: string;
  headers: string[];
  rows: string[][]; // already formatted (unescaped) cell text; column 0 = label
  values: Array<Array<number | null>>; // raw numbers behind `rows` (column 0 = null) — drives value colouring
  totalRows: boolean[]; // per row: is this the Total row
  caption?: string;
}

const n = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function rlpValues(l: RlpLine): Array<number | null> {
  return [
    null, l.outlets, l.outletsOver100, l.woa, l.valueTarget, l.valueAch, l.achPct, l.visEligible, l.visAttempted,
    l.visApproved, l.visApprovedPct, l.linesOver100, l.linesPct, l.score, l.rank,
  ].map(n);
}

function notBillingValues(l: NotBillingLine): Array<number | null> {
  return [null, l.retailOutlets, l.wsOutlets, l.retailZero, l.retailZeroPct, l.wsZero, l.wsZeroPct, l.lmZeroRetail, l.lmZeroWs].map(n);
}

// Headers are IDENTICAL to the Excel Summary sheet (payout-tracker.excel.ts rlpHeaders / notBillingHeaders) —
// one wording everywhere (audit 2026-11-27).
export const RLP_HEADERS_TAIL = [
  'Outlet Count - As approved by Gifsy', 'Outlets > 100%', 'WoA', 'Value Target', 'Value Ach', 'Ach %',
  'Outlets eligible for Visibility payout', 'Visibility attempted (Outlets)', 'Approved', 'Approved %',
  'Outlets With >100% Ach of Line', '% Outlets', 'Score', 'Rank',
] as const;

export const NOT_BILLING_HEADERS_TAIL = [
  'Outlet Count - As approved by Gifsy - Retail', 'Outlet Count - As approved by Gifsy - WS',
  'Retail on ₹0 (this month)', 'Retail %', 'WS on ₹0 (this month)', 'WS %', 'Last month ₹0 - Retail', 'Last month ₹0 - WS',
] as const;

export const SCORE_CAPTION = 'Score (0–1) = 30% WoA + 30% Ach % + 20% Approved % + 20% % Outlets. Rank 1 = best. Counts include only KYC-approved outlets.';

const isTotal = (label: string) => isTotalLabel(label); // shared with the Excel writer (exact TOTAL_LABEL)

function rlpCells(l: RlpLine): string[] {
  return [
    l.label ?? '',
    fmtInt(l.outlets), fmtInt(l.outletsOver100), fmtPct1(l.woa),
    fmtMoney(l.valueTarget), fmtMoney(l.valueAch), fmtPct1(l.achPct),
    fmtInt(l.visEligible), fmtInt(l.visAttempted), fmtInt(l.visApproved), fmtPct1(l.visApprovedPct),
    fmtInt(l.linesOver100), fmtPct1(l.linesPct), fmtScore(l.score), fmtInt(l.rank),
  ];
}

function notBillingCells(l: NotBillingLine): string[] {
  return [
    l.label ?? '',
    fmtInt(l.retailOutlets), fmtInt(l.wsOutlets),
    fmtInt(l.retailZero), fmtPct1(l.retailZeroPct),
    fmtInt(l.wsZero), fmtPct1(l.wsZeroPct),
    fmtInt(l.lmZeroRetail), fmtInt(l.lmZeroWs),
  ];
}

function rlpTable(title: string, firstHeader: string, lines: RlpLine[]): TableSpec {
  return {
    title,
    headers: [firstHeader, ...RLP_HEADERS_TAIL],
    rows: lines.map(rlpCells),
    values: lines.map(rlpValues),
    totalRows: lines.map((l) => isTotal(l.label ?? '')),
    caption: SCORE_CAPTION,
  };
}

function notBillingTable(title: string, firstHeader: string, lines: NotBillingLine[]): TableSpec {
  return {
    title,
    headers: [firstHeader, ...NOT_BILLING_HEADERS_TAIL],
    rows: lines.map(notBillingCells),
    values: lines.map(notBillingValues),
    totalRows: lines.map((l) => isTotal(l.label ?? '')),
  };
}

function buildTables(s: TrackerSummary): TableSpec[] {
  return [
    rlpTable('1. Zone Summary – RLP', 'Zone', s.zoneRlp ?? []),
    notBillingTable('2. Zone Summary – Outlets Not yet Started Billing', 'Zone', s.zoneNotBilling ?? []),
    rlpTable('3. SM Summary – RLP', 'SM HQ', s.smRlp ?? []),
    notBillingTable('4. SM Summary – Outlets Not yet Started Billing', 'SM HQ', s.smNotBilling ?? []),
    rlpTable('5. Bottom 10 ASM HQs (by score)', 'ASM HQ', s.bottomAsm ?? []),
  ];
}

// ─── HTML ──────────────────────────────────────────────────────────────────────────────────────────────
const C_TEXT = '#1f2933';
const C_BORDER = '#d0d7e2';
const C_TOTAL = `#${TOTAL_FILL}`;
const C_MUTED = '#6b7280';

const CELL = `padding:6px 8px;border:1px solid ${C_BORDER};`;

/** Inline fill (+ text colour) for one summary VALUE cell, or null = plain. Never called for Total rows. */
export function valueTone(
  header: string,
  index: number,
  v: number | null,
  range: { lo: number; hi: number } | null,
): { bg: string; fg: string } | null {
  const rule = valueRuleOf(header, index);
  if (!rule || v === null) return null;
  if (rule.kind === 'rag') {
    const band = ragBand(rule, v);
    return band ? { bg: `#${BAND_STYLE[band].fill}`, fg: `#${BAND_STYLE[band].text}` } : null;
  }
  const bg = rule.kind === 'scale3' ? scale3Color(rule, v) : range ? scale2Color(v, range.lo, range.hi) : null;
  return bg ? { bg: `#${bg}`, fg: `#${BODY_TEXT}` } : null;
}

/** Min / max of each column over the NON-Total rows (feeds the 2-colour amount scale, like Excel's min→max). */
function columnRanges(t: TableSpec): Array<{ lo: number; hi: number } | null> {
  return t.headers.map((_, ci) => {
    const vs = t.values.filter((_, ri) => !t.totalRows[ri]).map((row) => row[ci]).filter((v): v is number => v !== null);
    return vs.length ? { lo: Math.min(...vs), hi: Math.max(...vs) } : null;
  });
}

function renderTableHtml(t: TableSpec): string {
  const head = t.headers
    .map((h, i) => {
      const align = i === 0 ? 'text-align:left;white-space:nowrap;' : 'text-align:right;';
      const fill = `#${SECTION_FILL[summarySection(h, i)]}`;
      return `<th bgcolor="${fill}" style="${CELL}background-color:${fill};color:#${HEADER_TEXT};font-weight:bold;${align}vertical-align:bottom;">${escapeHtml(h)}</th>`;
    })
    .join('');
  const ranges = columnRanges(t);
  const body = t.rows.length
    ? t.rows
        .map((cells, r) => {
          const total = t.totalRows[r];
          const rowStyle = total ? ` style="font-weight:bold;background-color:${C_TOTAL};"` : '';
          const tds = cells
            .map((c, i) => {
              const align = i === 0 ? 'text-align:left;white-space:nowrap;' : 'text-align:right;white-space:nowrap;';
              const bold = total ? 'font-weight:bold;' : '';
              const tone = total ? null : valueTone(t.headers[i], i, t.values[r]?.[i] ?? null, ranges[i]);
              return tone
                ? `<td bgcolor="${tone.bg}" style="${CELL}${align}background-color:${tone.bg};color:${tone.fg};">${escapeHtml(c)}</td>`
                : `<td style="${CELL}${align}${bold}">${escapeHtml(c)}</td>`;
            })
            .join('');
          return `<tr${rowStyle}>${tds}</tr>`;
        })
        .join('')
    : `<tr><td colspan="${t.headers.length}" style="${CELL}text-align:left;color:${C_MUTED};">No data</td></tr>`;

  const caption = t.caption
    ? `<p style="margin:4px 0 0 0;font-size:12px;color:${C_MUTED};">${escapeHtml(t.caption)}</p>`
    : '';

  return (
    `<p style="margin:24px 0 8px 0;font-weight:bold;font-size:15px;color:${C_TEXT};">${escapeHtml(t.title)}</p>` +
    `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%">` +
    `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:13px;min-width:600px;color:${C_TEXT};font-family:Arial,Helvetica,sans-serif;">` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    caption
  );
}

export function buildSubject(meta: TrackerEmailMeta): string {
  return `${meta.provisional ? 'PROVISIONAL – ' : ''}${meta.clientName} Payout Tracker – ${meta.monthLabel} (sales up to ${meta.salesAsOf})`;
}

function introSentence(meta: TrackerEmailMeta): string {
  return (
    `Please find below the ${meta.monthLabel} payout tracker summary` +
    (meta.provisional
      ? ` (provisional — sales up to ${meta.salesAsOf}; figures will change until the month is closed)`
      : '') +
    '. The outlet-level detail is in the attached Excel.'
  );
}

export const PROVISIONAL_NOTE = 'PROVISIONAL – not a payment file';
export const FOOTER = 'This is an automated report from Gifsy.';

export function renderTrackerEmail(
  meta: TrackerEmailMeta,
  summary: TrackerSummary,
): { subject: string; html: string; text: string } {
  const subject = buildSubject(meta);
  const tables = buildTables(summary);
  const intro = introSentence(meta);

  const provisionalBox = meta.provisional
    ? `<div style="margin:16px 0;padding:10px 14px;background-color:#FFF4D6;border:1px solid #D99A00;border-left:4px solid #D99A00;color:#7a4f00;font-weight:bold;">${escapeHtml(PROVISIONAL_NOTE)}</div>`
    : '';

  // Colour key (HTML only — the text fallback is unchanged): green / amber / red chips + the per-column thresholds,
  // so colour is never the only signal (the numbers are always printed too).
  const chip = (b: keyof typeof BAND_STYLE, label: string) =>
    `<td bgcolor="#${BAND_STYLE[b].fill}" style="padding:3px 8px;background-color:#${BAND_STYLE[b].fill};color:#${BAND_STYLE[b].text};font-size:12px;font-weight:bold;border:1px solid ${C_BORDER};white-space:nowrap;">${label}</td><td style="width:6px;font-size:1px;">&nbsp;</td>`;
  const colourKey =
    `<div style="margin:16px 0 0 0;font-size:12px;color:${C_MUTED};">` +
    `<p style="margin:0 0 6px 0;">${escapeHtml(COLOUR_KEY_INTRO)}</p>` +
    `<table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 6px 0;"><tr>` +
    chip('green', 'On track') + chip('amber', 'Watch') + chip('red', 'Needs attention') +
    `</tr></table>` +
    `<ul style="margin:0;padding:0 0 0 18px;">${colourKeyLines().map((l) => `<li style="margin:0 0 2px 0;">${escapeHtml(l)}</li>`).join('')}</ul>` +
    '</div>';

  const notes = dataNotesOf(meta);
  const notesBox = notes.length
    ? `<div style="margin:24px 0 0 0;padding:10px 14px;background-color:#F4F6FA;border:1px solid ${C_BORDER};border-left:4px solid #D99A00;font-size:13px;color:${C_TEXT};">` +
      `<p style="margin:0 0 6px 0;font-weight:bold;">${escapeHtml(DATA_NOTES_HEADING)}</p>` +
      `<ul style="margin:0;padding:0 0 0 18px;">${notes.map((n) => `<li style="margin:0 0 4px 0;">${escapeHtml(n)}</li>`).join('')}</ul>` +
      '</div>'
    : '';

  const html =
    '<!DOCTYPE html>' +
    '<html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(subject)}</title>` +
    '</head>' +
    `<body style="margin:0;padding:0;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:${C_TEXT};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">` +
    `<div style="padding:16px;max-width:100%;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${C_TEXT};">` +
    `<p style="margin:0 0 12px 0;">Dear Team,</p>` +
    `<p style="margin:0 0 12px 0;">${escapeHtml(intro)}</p>` +
    provisionalBox +
    colourKey +
    tables.map(renderTableHtml).join('') +
    notesBox +
    `<p style="margin:28px 0 0 0;font-size:12px;color:${C_MUTED};">${escapeHtml(FOOTER)}</p>` +
    '</div></body></html>';

  const text = renderText(meta, intro, tables);
  return { subject, html, text };
}

// ─── plain text ────────────────────────────────────────────────────────────────────────────────────────
function renderTableText(t: TableSpec): string {
  const all = [t.headers, ...t.rows];
  const widths = t.headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? (c ?? '').padEnd(widths[i]) : (c ?? '').padStart(widths[i]))).join(' | ');
  const out = [t.title, line(t.headers), widths.map((w) => '-'.repeat(w)).join('-+-')];
  if (t.rows.length) out.push(...t.rows.map(line));
  else out.push('No data');
  if (t.caption) out.push(t.caption);
  return out.join('\n');
}

function renderText(meta: TrackerEmailMeta, intro: string, tables: TableSpec[]): string {
  const parts = [buildSubject(meta), '', 'Dear Team,', '', intro];
  if (meta.provisional) parts.push('', `*** ${PROVISIONAL_NOTE} ***`);
  for (const t of tables) parts.push('', renderTableText(t));
  const notes = dataNotesOf(meta);
  if (notes.length) parts.push('', DATA_NOTES_HEADING, ...notes.map((n) => `- ${n}`));
  parts.push('', FOOTER);
  return parts.join('\n') + '\n';
}
