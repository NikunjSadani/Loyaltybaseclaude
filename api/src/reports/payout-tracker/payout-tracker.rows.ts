/**
 * Bajaj payout tracker — row builder (PURE). See payout-tracker.types.ts for the shared contract.
 *
 * Lays out engine-computed payouts / points onto the RETAIL (Unnati / SAMT) and WS (BSC) sheets, derives display
 * ratios + flags and sums parts. It NEVER re-derives a payout. Outlets that fit neither sheet go to `exceptions`
 * (never dropped silently).
 */
import {
  CASE_KPI,
  ChainLink,
  KPI,
  OutletInput,
  PartResult,
  RETAIL_COLUMNS,
  RetailRow,
  Row,
  TrackerException,
  TrackerInput,
  TrackerRows,
  WsRow,
  wsColumns,
} from './payout-tracker.types';

const ACH_CAP = 1.2;
const NA = 'NA';

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
const str = (s: string | null | undefined): string => s ?? '';

type Sheet = 'retail' | 'ws';
function routeOf(program: string | null): Sheet | null {
  const p = norm(program);
  if (p === 'unnati' || p === 'samt') return 'retail';
  if (p === 'bsc') return 'ws';
  return null;
}

// ─── chain ──────────────────────────────────────────────────────────────────────────────────────────────
interface ChainView { isrName: string; soHq: string; soName: string; asmHq: string; asmName: string; smHq: string; smName: string; smPresent: boolean; asmPresent: boolean }

function findLink(chain: ChainLink[], level: string): ChainLink | undefined {
  return (chain ?? []).find((l) => norm(l.level) === level.toLowerCase());
}
function linkName(l: ChainLink | undefined): string {
  if (!l || !l.active || !l.name || !l.name.trim()) return 'Vacant';
  return l.name;
}
function linkHq(l: ChainLink | undefined): string {
  return l ? str(l.hq) : '';
}
function chainView(chain: ChainLink[]): ChainView {
  const isr = findLink(chain, 'XSR');
  const so = findLink(chain, 'SO');
  const asm = findLink(chain, 'ASM');
  const sm = findLink(chain, 'RSM');
  return {
    isrName: linkName(isr),
    soHq: linkHq(so),
    soName: linkName(so),
    asmHq: linkHq(asm),
    asmName: linkName(asm),
    smHq: linkHq(sm),
    smName: linkName(sm),
    smPresent: !!sm && !!linkHq(sm),
    asmPresent: !!asm && !!linkHq(asm),
  };
}
function smMeta(c: ChainView): { smKey: string; smLabel: string } {
  if (!c.smPresent) return { smKey: '(no SM)', smLabel: '(no SM)' };
  return { smKey: c.smHq, smLabel: `${c.smHq} — ${c.smName}` };
}

// ─── numeric helpers ────────────────────────────────────────────────────────────────────────────────────
const val = (rec: Partial<Record<string, number | null>> | undefined, k: string): number | null => {
  const v = rec?.[k];
  return v === undefined || v === null || Number.isNaN(v) ? null : v;
};
/** ach / target; null when target null or 0. Null ach counts 0. */
function ratio(ach: number | null, target: number | null): number | null {
  if (target === null || target === 0) return null;
  return (ach ?? 0) / target;
}
function cappedRatio(ach: number | null, target: number | null): number | null {
  const r = ratio(ach, target);
  return r === null ? null : Math.min(r, ACH_CAP);
}
function woa(ach: number | null, target: number | null): number {
  return target !== null && target > 0 && (ach ?? 0) >= target ? 1 : 0;
}
const amt = (p: PartResult | undefined): number => (p && Number.isFinite(p.amount) ? p.amount : 0);

/** An earning outlet that is not KYC-approved says so (it shows its figure but Gifsy Approval = 0). */
function withKyc(reason: string, earns: boolean, approved: boolean): string {
  if (!earns || approved) return reason;
  return reason ? `KYC not approved by Gifsy; ${reason}` : 'KYC not approved by Gifsy';
}

function zeroReasons(parts: Array<PartResult | undefined>): string {
  const out: string[] = [];
  for (const p of parts) {
    if (!p || amt(p) !== 0) continue;
    const r = (p.reason ?? '').trim();
    if (r && !out.includes(r)) out.push(r);
  }
  return out.join('; ');
}

function popStrata(metro: string | null): string {
  const m = norm(metro);
  if (m === 'yes' || m === 'metro') return 'Metro';
  if (m === 'no' || m === 'non metro') return 'Non Metro';
  return '';
}

function subProgramLabel(program: string | null, sub: string | null): string {
  const p = norm(program);
  const s = norm(sub);
  if (p === 'unnati' && s === 'unnati') return 'Unnati';
  if (p === 'unnati' && s === 'lite') return 'Unnati Lite';
  if (p === 'samt' && s === 'elite') return 'SAMT Elite';
  if (p === 'samt' && s === 'privilege') return 'SAMT Privilege';
  return str(sub);
}

function visibilityLabel(v: OutletInput['visibility']): string {
  switch (v) {
    case null:
    case undefined:
      return 'Visibility not Executed';
    case 'APPROVED':
      return 'Approved';
    case 'SUBMITTED':
      return 'Pending review';
    case 'REJECTED':
    case 'CHANGES_REQUESTED':
      return 'Rejected';
    default:
      return String(v);
  }
}

function emptyRow(columns: readonly string[]): Row {
  const r: Row = {};
  for (const c of columns) r[c] = null;
  return r;
}

// ─── retail ─────────────────────────────────────────────────────────────────────────────────────────────
function buildRetailRow(o: OutletInput): RetailRow {
  const c = chainView(o.chain);
  const isSamt = norm(o.program) === 'samt';
  const isLite = !isSamt && norm(o.subProgram) === 'lite';
  const t = o.targets ?? {};
  const a = o.achievements ?? {};
  const pay = o.payout ?? {};
  const strata = popStrata(o.metro);

  const totalT = val(t, KPI.TOTAL);
  const totalA = val(a, KPI.TOTAL);
  const adhoT = val(t, KPI.ADHO);
  const adhoA = val(a, KPI.ADHO);
  const nonT = val(t, KPI.NON_ADHO);
  const nonA = val(a, KPI.NON_ADHO);
  const fbT = val(t, KPI.FB);
  const fbA = val(a, KPI.FB);
  const lineT = val(t, KPI.LINES);
  const lineA = val(a, KPI.LINES);

  let window: number | string;
  if (isSamt) window = NA;
  else if (isLite) window = 0;
  else window = o.visibility === 'APPROVED' ? (strata === 'Metro' ? 500 : strata === 'Non Metro' ? 250 : 0) : 0;

  const performance = isSamt
    ? amt(pay.TOTAL)
    : amt(pay.ADHO) + amt(pay['NON ADHO']) + amt(pay['FOCUS BRAND']);
  const visPayout: number | string = isSamt ? NA : amt(pay.VISIBILITY);
  const linePayout = amt(pay.LINES);
  const total = performance + (typeof visPayout === 'number' ? visPayout : 0) + linePayout;
  const reasonParts = isSamt
    ? [pay.TOTAL, pay.LINES]
    : [pay.ADHO, pay['NON ADHO'], pay['FOCUS BRAND'], pay.VISIBILITY, pay.LINES];

  const cells = emptyRow(RETAIL_COLUMNS);
  Object.assign(cells, {
    Zone: str(o.zone),
    State: str(o.state),
    'SM HQ': c.smHq,
    'ASM HQ': c.asmHq,
    'SO HQ': c.soHq,
    'SAP Code': str(o.sapCode),
    'DB Name': str(o.dbName),
    TOWN: str(o.town),
    'POP STRATA': strata,
    'Customer Code': str(o.code),
    'Customer Name': str(o.name),
    'SM Name': c.smName,
    ASM: c.asmName,
    SO: c.soName,
    'ISR Name': c.isrName,
    'Beat Name': str(o.beat),
    Program: str(o.program),
    'Sub- Program': subProgramLabel(o.program, o.subProgram),
    'Outlet Type': o.outletTypeLabel ?? o.outletTypeCode ?? '',
    'SUB CHANNEL': isSamt ? 'SAMT' : 'Grocers',
    'Total Target': totalT,
    'Total Ach': totalA,
    'Total Ach %': ratio(totalA, totalT),
    'ADHO Target': adhoT,
    'ADHO Ach': adhoA,
    'ADHO Ach %': cappedRatio(adhoA, adhoT),
    'Non ADHO Target': nonT,
    'Non ADHO Ach': nonA,
    'Non ADHO Ach %': cappedRatio(nonA, nonT),
    'FB Target': isSamt ? NA : fbT,
    'FB Ach': isSamt ? NA : fbA,
    'FB Ach %': isSamt ? NA : cappedRatio(fbA, fbT),
    'Line Target': lineT,
    'Line Ach': lineA,
    'Line Ach %': ratio(lineA, lineT),
    'Payout per Window': window,
    'Potential Payout': window,
    'Visibility Status': visibilityLabel(o.visibility),
    WORKING: o.visibility !== null && o.visibility !== undefined ? 1 : 0,
    'Approved Visibility Payout': o.visibility === 'APPROVED' ? 1 : 0,
    ECO: (totalA ?? 0) > 0 ? 1 : 0,
    WOA: woa(totalA, totalT),
    'Performance Payout': performance,
    'Visibility Payout': visPayout,
    'Line Payout': linePayout,
    'Total Payout': total,
    Reason: withKyc(zeroReasons(reasonParts), total > 0, o.gifsyApproved),
    // Owner 2026-11-27: 1 only when the outlet earns a payout AND is KYC-approved by Gifsy.
    'Gifsy Approval': total > 0 && o.gifsyApproved ? 1 : 0,
  } satisfies Record<(typeof RETAIL_COLUMNS)[number], string | number | null>);

  return {
    cells,
    meta: {
      approved: o.gifsyApproved,
      lastMonthTotal: o.lastMonthTotal,
      ...smMeta(c),
      asmHq: c.asmPresent ? c.asmHq : '(no ASM)',
      zone: o.zone && o.zone.trim() ? o.zone : '(no zone)',
    },
  };
}

// ─── wholesale (BSC) ────────────────────────────────────────────────────────────────────────────────────
function buildWsRow(o: OutletInput, input: TrackerInput, columns: string[]): WsRow {
  const c = chainView(o.chain);
  const t = o.targets ?? {};
  const a = o.achievements ?? {};
  const totalT = val(t, KPI.TOTAL);
  const totalA = val(a, KPI.TOTAL);
  const base = o.bsc?.base;
  const fb1 = o.bsc?.fb1;
  const fb2 = o.bsc?.fb2;
  const totalPoints = amt(base) + amt(fb1) + amt(fb2);
  // Bonus cell: outside the quarter-end month → "paid in …"; quarter-end → the engine figure only when COMPUTED; a
  // not-computed / not-applicable bonus is a dash with the reason and adds nothing — never a printed 0.
  let bonusCell: number | string;
  let bonus = 0;
  let bonusZeroReason: string | null = null;
  if (!input.isQuarterEnd) {
    bonusCell = `— (paid in ${input.bonusPaidIn})`;
  } else {
    const status =
      o.bonusStatus ?? (o.consistencyBonus === null || o.consistencyBonus === undefined ? 'not-computed' : 'computed');
    if (status === 'computed') {
      bonus = Number.isFinite(o.consistencyBonus) ? (o.consistencyBonus as number) : 0;
      bonusCell = bonus;
      if (bonus === 0 && (o.bonusReason ?? '').trim()) bonusZeroReason = `Consistency bonus 0: ${(o.bonusReason as string).trim()}`;
    } else if (status === 'not-applicable') {
      bonusCell = '— (not applicable)';
    } else {
      const why = (o.bonusReason ?? '').trim() || (input.bonusNote ?? '').trim() || 'reason not given';
      bonusCell = `— (not computed: ${why})`;
    }
  }
  const finalPoints = totalPoints + bonus;

  const cells = emptyRow(columns);
  Object.assign(cells, {
    Zone: str(o.zone),
    State: str(o.state),
    'SM HQ': c.smHq,
    'ASM HQ': c.asmHq,
    'SO HQ': c.soHq,
    'SM Name': c.smName,
    ASM: c.asmName,
    SO: c.soName,
    'SAP Code': str(o.sapCode),
    'DB Name': str(o.dbName),
    CODE: str(o.code),
    'Customer Name': str(o.name),
    'WH Name': o.ownerName ?? '',
    Target: totalT,
    Ach: totalA,
    'Ach%': ratio(totalA, totalT),
    'Ach WOA': woa(totalA, totalT),
    'Total Cases': val(a, CASE_KPI.BASE),
    'FB1 Cases': val(a, CASE_KPI.FB1),
    'FB2 Cases': val(a, CASE_KPI.FB2),
    'Base Points': amt(base),
    'FB1 Points': amt(fb1),
    'FB2 Points': amt(fb2),
    'Total Points': totalPoints,
    Reason: withKyc(
      [zeroReasons([base, fb1, fb2]), bonusZeroReason].filter((x): x is string => !!x).join('; '),
      finalPoints > 0,
      o.gifsyApproved,
    ),
    [`Consistency Bonus (${input.quarterLabel})`]: bonusCell,
    'Final Points': finalPoints,
    'Gifsy Approval': finalPoints > 0 && o.gifsyApproved ? 1 : 0,
  });

  return {
    cells,
    meta: {
      approved: o.gifsyApproved,
      lastMonthTotal: o.lastMonthTotal,
      ...smMeta(c),
      zone: o.zone && o.zone.trim() ? o.zone : '(no zone)',
      totalAch: totalA,
    },
  };
}

// ─── sort ───────────────────────────────────────────────────────────────────────────────────────────────
const cmp = (x: unknown, y: unknown): number =>
  String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });

function sortRows<T extends { cells: Row }>(rows: T[], codeKey: string): T[] {
  const keys = ['Zone', 'SM HQ', 'ASM HQ', 'SO HQ', codeKey];
  return rows.sort((r1, r2) => {
    for (const k of keys) {
      const d = cmp(r1.cells[k], r2.cells[k]);
      if (d !== 0) return d;
    }
    return 0;
  });
}

// ─── entry ──────────────────────────────────────────────────────────────────────────────────────────────
export function buildRows(input: TrackerInput): TrackerRows {
  const retail: RetailRow[] = [];
  const ws: WsRow[] = [];
  const exceptions: TrackerException[] = [];
  const wsCols = wsColumns(input.quarterLabel);

  for (const o of input.outlets ?? []) {
    const route = routeOf(o.program);
    if (route === 'retail') retail.push(buildRetailRow(o));
    else if (route === 'ws') ws.push(buildWsRow(o, input, wsCols));
    else
      exceptions.push({
        code: str(o.code),
        name: str(o.name),
        reason: `Unknown programme "${o.program ?? '(none)'}" / sub-programme "${o.subProgram ?? '(none)'}"`,
      });
  }

  return { retail: sortRows(retail, 'Customer Code'), ws: sortRows(ws, 'CODE'), exceptions };
}
