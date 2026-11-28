/**
 * Bajaj payout tracker — VISUAL FORMATTING rules shared by the workbook (payout-tracker.excel.ts) and the email
 * (payout-tracker.email.ts). PURE: no IO.
 *
 *  1. Section colours: every column header is coloured by the SECTION it belongs to (outlet / sales hierarchy /
 *     targets / achievement / visibility / outcome). Header text is white; every fill clears 4.5:1 against it.
 *  2. Value colouring (Summary values ONLY — never outlet rows, never Total rows):
 *     - RAG bands (green / amber / red) on the ratio columns, by fixed thresholds (VALUE_RULES below);
 *     - a fixed-anchor 3-colour scale on Score;
 *     - a 2-colour (white → blue) scale on the ₹ Value Target / Value Ach columns, min → max of the table.
 *  Colour is never the only signal: the number is always printed, and the email carries a colour key.
 *
 *  The RAG band is decided on the value ROUNDED to the printed precision (1-decimal %), never the raw value.
 *
 *  ⚠️ The thresholds / anchors are OWNER DECISIONS (2026-11-27 first cut) — change them here only; Excel and
 *  email both read this file.
 */

import { TOTAL_LABEL } from './payout-tracker.summary';

// ─── Section palette ───────────────────────────────────────────────────────────────────────────────────
export type Section = 'outlet' | 'hierarchy' | 'target' | 'achievement' | 'visibility' | 'outcome';

export const SECTION_LABEL: Record<Section, string> = {
  outlet: 'Outlet & distributor',
  hierarchy: 'Sales hierarchy',
  target: 'Targets',
  achievement: 'Achievement',
  visibility: 'Visibility',
  outcome: 'Payout / points / score',
};

/** Header fill per section (hex, no '#'), all with WHITE bold text. */
export const SECTION_FILL: Record<Section, string> = {
  outlet: '34495E', // slate
  hierarchy: '00796B', // teal
  target: '1F5FA8', // blue
  achievement: '2E7D32', // green
  visibility: '6A3FA0', // purple
  outcome: 'B45309', // burnt amber
};
export const HEADER_TEXT = 'FFFFFF';

const HIERARCHY = new Set(['SM HQ', 'ASM HQ', 'SO HQ', 'SM Name', 'ASM', 'SO', 'ISR Name']);
const VISIBILITY = new Set(['Payout per Window', 'Potential Payout', 'Visibility Status', 'WORKING', 'Approved Visibility Payout']);
const OUTCOME = new Set([
  'Performance Payout', 'Visibility Payout', 'Line Payout', 'Total Payout', 'Reason', 'Gifsy Approval', 'Final Points',
]);
const ACHIEVEMENT = new Set(['Ach', 'Ach%', 'Ach WOA', 'ECO', 'WOA', 'Total Cases', 'FB1 Cases', 'FB2 Cases']);

/** Section of a column on the OUTLET sheets (retail + Ws). Anything unlisted = outlet identity. */
export function outletSheetSection(h: string): Section {
  if (HIERARCHY.has(h)) return 'hierarchy';
  if (VISIBILITY.has(h)) return 'visibility';
  if (OUTCOME.has(h) || h.endsWith('Points') || h.startsWith('Consistency Bonus')) return 'outcome';
  if (h === 'Target' || h.endsWith(' Target')) return 'target';
  if (ACHIEVEMENT.has(h) || h.endsWith(' Ach') || h.endsWith(' Ach %')) return 'achievement';
  return 'outlet';
}

const SUMMARY_SECTION: Record<string, Section> = {
  'Outlets > 100%': 'achievement',
  WoA: 'achievement',
  'Value Target': 'target',
  'Value Ach': 'achievement',
  'Ach %': 'achievement',
  'Outlets eligible for Visibility payout': 'visibility',
  'Visibility attempted (Outlets)': 'visibility',
  Approved: 'visibility',
  'Approved %': 'visibility',
  'Outlets With >100% Ach of Line': 'achievement',
  '% Outlets': 'achievement',
  Score: 'outcome',
  Rank: 'outcome',
  'Retail on ₹0 (this month)': 'achievement',
  'Retail %': 'achievement',
  'WS on ₹0 (this month)': 'achievement',
  'WS %': 'achievement',
};

/** Section of a Summary-table column (Excel Summary sheet + email — the headers are identical). Column 0 = the
 *  group label (Zone / SM HQ / ASM HQ) = sales hierarchy; outlet counts + last-month reference = outlet. */
export function summarySection(h: string, index: number): Section {
  if (index === 0) return 'hierarchy';
  return SUMMARY_SECTION[h] ?? 'outlet';
}

// ─── Value rules (Summary only) ────────────────────────────────────────────────────────────────────────
export type Band = 'green' | 'amber' | 'red';

/** RAG on a fraction. higherIsBetter: ≥ green → green, ≥ amber → amber, else red.
 *  lowerIsBetter: ≤ green → green, ≤ amber → amber, else red. */
export interface RagRule { kind: 'rag'; higherIsBetter: boolean; green: number; amber: number }
/** 3-colour scale with FIXED anchors (values outside clamp to the end colours). */
export interface Scale3Rule { kind: 'scale3'; min: number; mid: number; max: number }
/** 2-colour scale from the table's lowest to highest value. */
export interface Scale2Rule { kind: 'scale2' }
export type ValueRule = RagRule | Scale3Rule | Scale2Rule;

export const VALUE_RULES: Record<string, ValueRule> = {
  'Ach %': { kind: 'rag', higherIsBetter: true, green: 1.0, amber: 0.9 },
  WoA: { kind: 'rag', higherIsBetter: true, green: 0.5, amber: 0.3 },
  'Approved %': { kind: 'rag', higherIsBetter: true, green: 0.8, amber: 0.6 },
  '% Outlets': { kind: 'rag', higherIsBetter: true, green: 0.5, amber: 0.3 },
  'Retail %': { kind: 'rag', higherIsBetter: false, green: 0.1, amber: 0.25 },
  'WS %': { kind: 'rag', higherIsBetter: false, green: 0.1, amber: 0.25 },
  Score: { kind: 'scale3', min: 0.4, mid: 0.6, max: 0.8 },
  'Value Target': { kind: 'scale2' },
  'Value Ach': { kind: 'scale2' },
};

export function valueRuleOf(h: string, index: number): ValueRule | null {
  if (index === 0) return null;
  return VALUE_RULES[h] ?? null;
}

/** Fill + text per band (light fills, dark text — all ≥ 4.5:1). */
export const BAND_STYLE: Record<Band, { fill: string; text: string }> = {
  green: { fill: 'D1E7DD', text: '0F5132' },
  amber: { fill: 'FFF3CD', text: '664D03' },
  red: { fill: 'F8D7DA', text: '842029' },
};

/** Scale end colours (dark body text #1f2933 stays on top). */
export const SCALE3_COLORS = { min: 'F4B6B6', mid: 'FFEB9C', max: 'B7DFB9' } as const;
export const SCALE2_COLORS = { min: 'FFFFFF', max: 'A9CCE3' } as const;
export const BODY_TEXT = '1F2933';

/** Total rows: bold + this light fill, never value-coloured. */
export const TOTAL_FILL = 'F4F6FA';

/** THE Total-row test for both Excel and email: exact match on the label buildSummary writes. */
export function isTotalLabel(label: unknown): boolean {
  return label === TOTAL_LABEL;
}

/** RAG columns print 1-decimal % → band on the fraction rounded to 3 decimals, so the colour always matches
 *  the printed number (0.99951 prints "100.0%" → green). Excel CF does the same with ROUND(x,3). */
export const RAG_ROUND_DECIMALS = 3;
export function roundForBand(v: number): number {
  const k = 10 ** RAG_ROUND_DECIMALS;
  return Math.round(v * k) / k;
}

export function ragBand(rule: RagRule, raw: number | null | undefined): Band | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
  const v = roundForBand(raw);
  if (rule.higherIsBetter) return v >= rule.green ? 'green' : v >= rule.amber ? 'amber' : 'red';
  return v <= rule.green ? 'green' : v <= rule.amber ? 'amber' : 'red';
}

// ─── colour maths (email interpolation + contrast checks) ──────────────────────────────────────────────
function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function hex2(n: number): string {
  return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
}
export function mix(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return hex2(ar + (br - ar) * k) + hex2(ag + (bg - ag) * k) + hex2(ab + (bb - ab) * k);
}

/** Fixed-anchor 3-colour scale (same maths as Excel's num-anchored colour scale). */
export function scale3Color(rule: Scale3Rule, v: number | null | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (v <= rule.mid) return mix(SCALE3_COLORS.min, SCALE3_COLORS.mid, (v - rule.min) / (rule.mid - rule.min));
  return mix(SCALE3_COLORS.mid, SCALE3_COLORS.max, (v - rule.mid) / (rule.max - rule.mid));
}

/** Min → max 2-colour scale; a flat range (or a single value) gets the low colour, like Excel. */
export function scale2Color(v: number | null | undefined, lo: number, hi: number): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (!(hi > lo)) return SCALE2_COLORS.min;
  return mix(SCALE2_COLORS.min, SCALE2_COLORS.max, (v - lo) / (hi - lo));
}

function luminance(hex: string): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two hex colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ─── human key (email legend + About sheet) ────────────────────────────────────────────────────────────
const pct = (f: number) => `${Math.round(f * 100)}%`;

function ragKey(h: string, r: RagRule): string {
  return r.higherIsBetter
    ? `${h}: green ≥ ${pct(r.green)} · amber ${pct(r.amber)} to < ${pct(r.green)} · red < ${pct(r.amber)}`
    : `${h} (lower is better): green ≤ ${pct(r.green)} · amber > ${pct(r.green)} to ≤ ${pct(r.amber)} · red > ${pct(r.amber)}`;
}

/** One line per coloured summary column, derived from VALUE_RULES (never hand-copied). */
export function colourKeyLines(): string[] {
  const out: string[] = [];
  for (const [h, r] of Object.entries(VALUE_RULES)) {
    if (r.kind === 'rag') out.push(ragKey(h, r));
  }
  const s = VALUE_RULES['Score'] as Scale3Rule;
  out.push(`Score: red ≤ ${s.min.toFixed(2)} → yellow ${s.mid.toFixed(2)} → green ≥ ${s.max.toFixed(2)}`);
  out.push('Value Target / Value Ach: deeper blue = larger amount within the table');
  return out;
}

export const COLOUR_KEY_INTRO = 'Colour key (summary values only; Total rows are not coloured):';
