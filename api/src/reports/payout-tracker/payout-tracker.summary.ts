/**
 * Bajaj payout tracker — SUMMARY (email body + Summary sheet). PURE: no DB / IO.
 *
 * Owner definitions 2026-11-27 (see payout-tracker.types.ts):
 *  - Only APPROVED outlets (meta.approved === true) count in every count / sum, EXCEPT totals.retailPayout and
 *    totals.wsPoints, which sum over ALL rows.
 *  - Total lines recompute their ratios from the summed counts (never an average of the group ratios).
 *  - rank = 1 + number of sibling (non-Total) lines with a strictly higher score; ties share a rank.
 */
import {
  NotBillingLine,
  RANK_WEIGHTS,
  RetailRow,
  RlpLine,
  TrackerRows,
  TrackerSummary,
  WsRow,
} from './payout-tracker.types';

export const TOTAL_LABEL = 'Total';
const ZONE_ORDER = ['NORTH', 'EAST', 'WEST', 'SOUTH'];
const BOTTOM_ASM_COUNT = 10;

/** Numeric cell value; anything non-numeric (null, '', text, NaN) → 0. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function ratio(n: number, d: number): number | null {
  return d === 0 ? null : n / d;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Visibility eligibility: Program Unnati with Sub-Program Unnati (not Lite), or Program SAMT. */
function isVisEligible(r: RetailRow): boolean {
  const program = str(r.cells['Program']).toUpperCase();
  const sub = str(r.cells['Sub- Program']).toUpperCase();
  return (program === 'UNNATI' && sub === 'UNNATI') || program === 'SAMT';
}

function linesOver100(r: RetailRow): boolean {
  const t = r.cells['Line Target'];
  const a = r.cells['Line Ach'];
  return typeof t === 'number' && Number.isFinite(t) && t > 0 && typeof a === 'number' && Number.isFinite(a) && a >= t;
}

/** RlpLine for a group of (already approved-filtered) retail rows; rank filled later. */
export function rlpLine(label: string, rows: RetailRow[]): RlpLine {
  const outlets = rows.length;
  const outletsOver100 = rows.filter((r) => r.cells['WOA'] === 1).length;
  const valueTarget = rows.reduce((s, r) => s + num(r.cells['Total Target']), 0);
  const valueAch = rows.reduce((s, r) => s + num(r.cells['Total Ach']), 0);
  const eligible = rows.filter(isVisEligible);
  const visAttempted = eligible.filter((r) => r.cells['WORKING'] === 1).length;
  const visApproved = eligible.filter((r) => r.cells['Approved Visibility Payout'] === 1).length;
  const lines = rows.filter(linesOver100).length;

  const woa = ratio(outletsOver100, outlets);
  const achPct = ratio(valueAch, valueTarget);
  const visApprovedPct = ratio(visApproved, visAttempted);
  const linesPct = ratio(lines, outlets);
  const score =
    outlets === 0
      ? null
      : RANK_WEIGHTS.woa * (woa ?? 0) +
        RANK_WEIGHTS.ach * (achPct ?? 0) +
        RANK_WEIGHTS.visApproved * (visApprovedPct ?? 0) +
        RANK_WEIGHTS.lines * (linesPct ?? 0);

  return {
    label,
    outlets,
    outletsOver100,
    woa,
    valueTarget,
    valueAch,
    achPct,
    visEligible: eligible.length,
    visAttempted,
    visApproved,
    visApprovedPct,
    linesOver100: lines,
    linesPct,
    score,
    rank: null,
  };
}

/** Assign competition ranks in place (1 + count of strictly higher scores). Null score → null rank. */
function assignRanks(lines: RlpLine[]): void {
  for (const l of lines) {
    l.rank = l.score === null ? null : 1 + lines.filter((o) => o.score !== null && o.score > (l.score as number)).length;
  }
}

function notBillingLine(label: string, retail: RetailRow[], ws: WsRow[]): NotBillingLine {
  const lmZero = (v: number | null) => v === null || v <= 0;
  const retailZero = retail.filter((r) => num(r.cells['Total Ach']) <= 0).length;
  const wsZero = ws.filter((w) => num(w.meta.totalAch) <= 0).length;
  return {
    label,
    retailOutlets: retail.length,
    wsOutlets: ws.length,
    retailZero,
    retailZeroPct: ratio(retailZero, retail.length),
    wsZero,
    wsZeroPct: ratio(wsZero, ws.length),
    lmZeroRetail: retail.filter((r) => lmZero(r.meta.lastMonthTotal)).length,
    lmZeroWs: ws.filter((w) => lmZero(w.meta.lastMonthTotal)).length,
  };
}

/** Zone sort key: North, East, West, South first (case-insensitive), then others alphabetically. */
function zoneRank(zone: string): number {
  const i = ZONE_ORDER.indexOf(zone.trim().toUpperCase());
  return i === -1 ? ZONE_ORDER.length : i;
}
function compareZones(a: string, b: string): number {
  return zoneRank(a) - zoneRank(b) || a.localeCompare(b);
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

interface SmGroup { key: string; label: string; zone: string; retail: RetailRow[]; ws: WsRow[] }

/** SM groups by smKey across retail (+ ws). Sort zone = the best-ordered zone among its rows. */
function smGroups(retail: RetailRow[], ws: WsRow[]): SmGroup[] {
  const m = new Map<string, SmGroup>();
  const touch = (key: string, label: string, zone: string): SmGroup => {
    let g = m.get(key);
    if (!g) {
      g = { key, label, zone, retail: [], ws: [] };
      m.set(key, g);
    } else if (compareZones(zone, g.zone) < 0) {
      g.zone = zone;
    }
    return g;
  };
  for (const r of retail) touch(r.meta.smKey, r.meta.smLabel, r.meta.zone).retail.push(r);
  for (const w of ws) touch(w.meta.smKey, w.meta.smLabel, w.meta.zone).ws.push(w);
  return [...m.values()].sort(
    (a, b) => compareZones(a.zone, b.zone) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
}

export function buildSummary(rows: TrackerRows): TrackerSummary {
  const retail = rows.retail.filter((r) => r.meta.approved === true);
  const ws = rows.ws.filter((w) => w.meta.approved === true);

  // Zone RLP
  const retailByZone = groupBy(retail, (r) => r.meta.zone);
  const zoneRlp = [...retailByZone.keys()].sort(compareZones).map((z) => rlpLine(z, retailByZone.get(z)!));
  assignRanks(zoneRlp);
  zoneRlp.push(rlpLine(TOTAL_LABEL, retail));

  // Zone not-billing (zones present in retail OR ws)
  const wsByZone = groupBy(ws, (w) => w.meta.zone);
  const allZones = [...new Set([...retailByZone.keys(), ...wsByZone.keys()])].sort(compareZones);
  const zoneNotBilling = allZones.map((z) => notBillingLine(z, retailByZone.get(z) ?? [], wsByZone.get(z) ?? []));
  zoneNotBilling.push(notBillingLine(TOTAL_LABEL, retail, ws));

  // SM RLP (retail-only groups) + SM not-billing (retail + ws groups)
  const smRlp = smGroups(retail, []).map((g) => rlpLine(g.label, g.retail));
  assignRanks(smRlp);
  smRlp.push(rlpLine(TOTAL_LABEL, retail));
  const smNotBilling = smGroups(retail, ws).map((g) => notBillingLine(g.label, g.retail, g.ws));
  smNotBilling.push(notBillingLine(TOTAL_LABEL, retail, ws));

  // Bottom ASM: rank across ALL ASM HQs, return the 10 lowest scores, worst first (ties by label).
  const byAsm = groupBy(retail, (r) => r.meta.asmHq);
  const asmLines = [...byAsm.entries()].map(([hq, rs]) => rlpLine(hq, rs));
  assignRanks(asmLines);
  const bottomAsm = asmLines
    .sort((a, b) => (a.score ?? -Infinity) - (b.score ?? -Infinity) || a.label.localeCompare(b.label))
    .slice(0, BOTTOM_ASM_COUNT);

  return {
    zoneRlp,
    zoneNotBilling,
    smRlp,
    smNotBilling,
    bottomAsm,
    totals: {
      retailPayout: rows.retail.reduce((s, r) => s + num(r.cells['Total Payout']), 0),
      wsPoints: rows.ws.reduce((s, w) => s + num(w.cells['Final Points']), 0),
      retailOutlets: retail.length,
      wsOutlets: ws.length,
    },
  };
}
