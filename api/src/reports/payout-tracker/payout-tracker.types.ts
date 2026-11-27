/**
 * Bajaj payout tracker — SHARED CONTRACT (owner decisions 2026-11-27, see plan §8).
 *
 * Pipeline (all PURE, no DB / IO — the product will feed them from Prisma + the points engine; the first
 * manual run feeds them from a read-only prod export):
 *   TrackerInput ─ buildRows → TrackerRows (payout-tracker.rows.ts)
 *               ─ buildSummary (payout-tracker.summary.ts)
 *               ─ writeTrackerWorkbook (payout-tracker.excel.ts)   → .xlsx Buffer
 *               ─ renderTrackerEmail (payout-tracker.email.ts)     → { subject, html, text }
 *
 * Money: payouts / points arrive ALREADY COMPUTED by the rules engine (whole ₹ / whole points). This module
 * never re-implements a rule; it only lays the figures out, derives display ratios/flags and aggregates.
 */

export const KPI = { TOTAL: 'TOTAL', ADHO: 'ADHO', NON_ADHO: 'NON ADHO', FB: 'FOCUS BRAND', FB2: 'FOCUS BRAND 2', LINES: 'LINES' } as const;
export const CASE_KPI = { BASE: 'BSC CASES', FB1: 'FB1 CASES', FB2: 'FB2 CASES' } as const;

/** Sales chain level codes as stored for Bajaj (sales_hierarchy_levels.code): XSR=ISR, SO, ASM, RSM=SM, ZNM=ZH, NSM. */
export type ChainLevel = 'XSR' | 'SO' | 'ASM' | 'RSM' | 'ZNM' | 'NSM' | string;
export interface ChainLink { level: ChainLevel; hq: string; name: string | null; active: boolean }

/** Final visibility status of the outlet's capture(s) for the month (null = none submitted). */
export type VisStatus = 'APPROVED' | 'SUBMITTED' | 'REJECTED' | 'CHANGES_REQUESTED' | null;

/** Engine result for one paying part: amount (₹ for payout, points for BSC) + reason when 0. */
export interface PartResult { amount: number; reason: string | null }

export interface OutletInput {
  code: string;
  name: string;
  ownerName: string | null;
  zone: string | null;
  state: string | null;
  town: string | null;
  beat: string | null;
  metro: string | null; // raw outlet-master value: Metro / Non Metro / Yes / No / null
  sapCode: string | null; // distributor code
  dbName: string | null; // distributor name
  program: string | null; // Unnati | SAMT | BSC
  subProgram: string | null; // Unnati | Lite | Elite | Privilege | BSC
  outletTypeCode: string | null; // SSS | SSS_TOT | WHOLESALER
  outletTypeLabel: string | null; // SSS | SSS TOT | Wholesaler
  gifsyApproved: boolean; // KYC approved by Gifsy (counts toward "Outlet Count – As approved by Gifsy")
  visibility: VisStatus;
  /** Active sales chain from the outlet's ISR upwards (index 0 = ISR). Empty = unassigned. */
  chain: ChainLink[];
  targets: Partial<Record<string, number | null>>; // by KPI code (₹, LINES = count)
  achievements: Partial<Record<string, number | null>>; // by KPI code incl. case KPIs (cases)
  /** Last month's TOTAL ₹ sales; null = no sales record at all last month. */
  lastMonthTotal: number | null;
  /** Engine payouts (₹ whole) for RLP outlets (Unnati / Lite / SAMT). Missing key = no rule / not applicable. */
  payout?: Partial<Record<'ADHO' | 'NON ADHO' | 'FOCUS BRAND' | 'LINES' | 'TOTAL' | 'VISIBILITY', PartResult>>;
  /** Engine BSC points (whole) for wholesalers. */
  bsc?: { base: PartResult; fb1: PartResult; fb2: PartResult };
  /** Quarterly consistency bonus points: number in the quarter-end month, null otherwise. */
  consistencyBonus?: number | null;
  /**
   * State of the quarterly bonus for this outlet: 'computed' (consistencyBonus is the engine figure, 0 included),
   * 'not-applicable' (not a quarter-end month / not a BSC outlet), 'not-computed' (quarter-end, but the bonus could
   * not be computed — reason in TrackerInput.bonusNote). A not-computed bonus is NEVER printed as 0.
   * Absent + a null bonus in a quarter-end month is treated as 'not-computed'.
   */
  bonusStatus?: 'computed' | 'not-applicable' | 'not-computed';
  /**
   * Per-outlet bonus reason: for 'not-computed' WHY (e.g. 'no quarterly rule for this outlet' / the rule's skip reason —
   * overrides TrackerInput.bonusNote); for a computed 0, the rule's reason (shown in the Reason column).
   */
  bonusReason?: string | null;
}

export interface TrackerInput {
  clientName: string; // "Bajaj Consumer Care"
  month: string; // 'YYYY-MM'
  monthLabel: string; // 'November 2026'
  /** Sales data as of (IST, human): e.g. '27 Nov 2026'. */
  salesAsOf: string;
  provisional: boolean; // true while the month is open in Sales Import
  /** Quarter label for the bonus column, e.g. 'Oct–Dec 2026'; bonusPaidIn e.g. 'December 2026'. */
  quarterLabel: string;
  bonusPaidIn: string;
  isQuarterEnd: boolean;
  outlets: OutletInput[];
  /**
   * Loud data notes from the loader (see TrackerNote): `client` ones are printed on the workbook About sheet ("Data
   * notes") and in the email ("Data notes" box); ALL of them go to ops in the heads-up email. [] = nothing to say.
   * Never used for money-critical states — those REFUSE the run.
   */
  notes: TrackerNote[];
  /** Why the quarterly bonus was not computed (quarter-end month only), e.g. 'October 2026 was imported from the old system'. */
  bonusNote?: string;
}

/**
 * A loud data note. `client` = a caveat the client should read (bonus not computed + why, visibility still pending) —
 * printed in the client email + workbook About sheet AND sent to ops. `ops` = internal housekeeping (no-rule / skip
 * lists, chain cycles, dropped codes, "check the rules") — ONLY in the ops heads-up email, never shown to the client.
 */
export interface TrackerNote {
  audience: 'client' | 'ops';
  text: string;
}

/** The client-facing note texts (email box + About sheet). Tolerates a missing / malformed list. */
export function clientNoteTexts(notes: unknown): string[] {
  return noteList(notes).filter((n) => n.audience === 'client').map((n) => n.text);
}

/** Every note (client + ops), validated. */
export function noteList(notes: unknown): TrackerNote[] {
  if (!Array.isArray(notes)) return [];
  return notes.filter(
    (n): n is TrackerNote =>
      !!n && typeof n === 'object' && ((n as TrackerNote).audience === 'client' || (n as TrackerNote).audience === 'ops') &&
      typeof (n as TrackerNote).text === 'string' && (n as TrackerNote).text.trim() !== '',
  );
}

// ─── Sheet columns (exact headers + order) ─────────────────────────────────────────────────────────────
export const RETAIL_COLUMNS = [
  'Zone', 'State', 'SM HQ', 'ASM HQ', 'SO HQ', 'SAP Code', 'DB Name', 'TOWN', 'POP STRATA', 'Customer Code',
  'Customer Name', 'SM Name', 'ASM', 'SO', 'ISR Name', 'Beat Name', 'Program', 'Sub- Program', 'Outlet Type', 'SUB CHANNEL',
  'Total Target', 'Total Ach', 'Total Ach %',
  'ADHO Target', 'ADHO Ach', 'ADHO Ach %',
  'Non ADHO Target', 'Non ADHO Ach', 'Non ADHO Ach %',
  'FB Target', 'FB Ach', 'FB Ach %',
  'Line Target', 'Line Ach', 'Line Ach %',
  'Payout per Window', 'Potential Payout', 'Visibility Status', 'WORKING', 'Approved Visibility Payout', 'ECO', 'WOA',
  'Performance Payout', 'Visibility Payout', 'Line Payout', 'Total Payout', 'Reason', 'Gifsy Approval',
] as const;

export const WS_COLUMNS_BASE = [
  'Zone', 'State', 'SM HQ', 'ASM HQ', 'SO HQ', 'SM Name', 'ASM', 'SO', 'SAP Code', 'DB Name', 'CODE', 'Customer Name',
  'WH Name', 'Target', 'Ach', 'Ach%', 'Ach WOA', 'Total Cases', 'FB1 Cases', 'FB2 Cases', 'Base Points', 'FB1 Points',
  'FB2 Points', 'Total Points', 'Reason',
] as const;
/** + `Consistency Bonus (<quarterLabel>)`, 'Final Points', 'Gifsy Approval' appended by wsColumns(). */
export function wsColumns(quarterLabel: string): string[] {
  return [...WS_COLUMNS_BASE, `Consistency Bonus (${quarterLabel})`, 'Final Points', 'Gifsy Approval'];
}

/** A sheet row = header → cell value (number | string | null). Ratios are FRACTIONS (1.17 = 117%). */
export type Row = Record<string, string | number | null>;

/** Extra fields the summary needs that are not sheet columns. */
export interface RetailRowMeta { approved: boolean; lastMonthTotal: number | null; smKey: string; smLabel: string; asmHq: string; zone: string }
export interface WsRowMeta { approved: boolean; lastMonthTotal: number | null; smKey: string; smLabel: string; zone: string; totalAch: number | null }

export interface RetailRow { cells: Row; meta: RetailRowMeta }
export interface WsRow { cells: Row; meta: WsRowMeta }

/** An outlet that could not be placed on either sheet — NEVER dropped silently: listed on an "Exceptions" sheet. */
export interface TrackerException { code: string; name: string; reason: string }

/** buildRows(input) (payout-tracker.rows.ts) returns this. */
export interface TrackerRows { retail: RetailRow[]; ws: WsRow[]; exceptions: TrackerException[] }

// ─── Summary (email body + Summary sheet) ──────────────────────────────────────────────────────────────
export const RANK_WEIGHTS = { woa: 0.3, ach: 0.3, visApproved: 0.2, lines: 0.2 } as const;

export interface RlpLine {
  label: string; // zone / SM HQ label / ASM HQ / 'Total'
  outlets: number; // D — approved RLP outlets
  outletsOver100: number; // E — WOA = 1
  woa: number | null; // F = E / D
  valueTarget: number; // G
  valueAch: number; // H
  achPct: number | null; // I = H / G
  visEligible: number; // J — Unnati + SAMT approved outlets
  visAttempted: number; // K — any capture this month
  visApproved: number; // L
  visApprovedPct: number | null; // M = L / K
  linesOver100: number; // N — Line Ach ≥ Line Target (> 0)
  linesPct: number | null; // O = N / D
  score: number | null; // 0.3·F + 0.3·I + 0.2·M + 0.2·O (null parts count 0)
  rank: number | null; // 1 = best score among non-Total lines
}

export interface NotBillingLine {
  label: string;
  retailOutlets: number; // D — approved retail (RLP)
  wsOutlets: number; // E — approved WS
  retailZero: number; // F — Total Ach ≤ 0 or none this month
  retailZeroPct: number | null; // G = F / D
  wsZero: number; // H
  wsZeroPct: number | null; // H / E
  lmZeroRetail: number; // I — last month TOTAL ≤ 0 or no record
  lmZeroWs: number; // J
}

export interface TrackerSummary {
  zoneRlp: RlpLine[]; // zones (+ Total last)
  zoneNotBilling: NotBillingLine[]; // zones incl. South (+ Total last)
  smRlp: RlpLine[]; // one per SM HQ, grouped by zone order (+ Total last)
  smNotBilling: NotBillingLine[];
  bottomAsm: RlpLine[]; // 10 lowest-score ASM HQs, WORST FIRST (rank = position among ALL ASM HQs)
  totals: { retailPayout: number; wsPoints: number; retailOutlets: number; wsOutlets: number };
}
