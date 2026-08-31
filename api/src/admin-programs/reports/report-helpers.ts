/**
 * Pure report helpers — ported locally from the platform's
 * `@/lib/points-ledger-export.ts` and `@/lib/ticket-aging-export.ts`
 * (the World-A DEMO_MODE / demo-data / mock branches are intentionally NOT
 * ported — RULE 3: real Prisma tables only).
 *
 * These are deterministic, side-effect-free functions used by the reports
 * service to shape rows; xlsx serialization is done via the shared
 * `buildXlsx` helper in common/xlsx.ts.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Points Ledger (R1)
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export interface ReportMonth {
  monthKey: string;
  label: string;
}

export interface PointsLedgerMonthCell {
  monthKey: string;
  label: string;
  earn: number;
  burn: number;
}

export interface OutletMeta {
  outletId: string;
  outletName: string;
  outletType?: string;
}

export interface LedgerEntry {
  type: string; // 'EARN' | 'REDEEM' | 'EXPIRE' | other
  points: number;
  createdAt: Date | string;
}

export interface PointsLedgerReportRow extends OutletMeta {
  openingBalance: number;
  months: PointsLedgerMonthCell[];
  totalEarn: number;
  totalBurn: number;
  totalExpired: number;
  closingBalance: number;
}

/**
 * Ordered list of months between from/to (YYYY-MM, inclusive). Throws
 * RangeError when from > to or the span exceeds 24 months — same as the source.
 */
export function monthsInRange(fromYYYYMM: string, toYYYYMM: string): ReportMonth[] {
  const [fromYear, fromMonth] = fromYYYYMM.split('-').map(Number);
  const [toYear, toMonth] = toYYYYMM.split('-').map(Number);

  const fromTotal = fromYear * 12 + (fromMonth - 1);
  const toTotal = toYear * 12 + (toMonth - 1);

  if (fromTotal > toTotal) {
    throw new RangeError(`from (${fromYYYYMM}) must not be after to (${toYYYYMM})`);
  }

  const count = toTotal - fromTotal + 1;
  if (count > 24) {
    throw new RangeError(
      `Period spans ${count} months — maximum allowed is 24 months (inclusive).`,
    );
  }

  const result: ReportMonth[] = [];
  for (let i = 0; i < count; i++) {
    const total = fromTotal + i;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const label = `${MONTH_NAMES[month - 1]} ${year}`;
    result.push({ monthKey, label });
  }
  return result;
}

/** Aggregate raw ledger entries into a PointsLedgerReportRow. */
export function aggregateLedgerToRow(
  meta: OutletMeta,
  openingBalance: number,
  entries: LedgerEntry[],
  months: ReportMonth[],
): PointsLedgerReportRow {
  const cellByKey = new Map<string, PointsLedgerMonthCell>();
  for (const m of months) {
    cellByKey.set(m.monthKey, { monthKey: m.monthKey, label: m.label, earn: 0, burn: 0 });
  }

  let totalEarn = 0;
  let totalBurn = 0;
  let totalExpired = 0;

  for (const entry of entries) {
    const d = entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdAt);
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const cell = cellByKey.get(monthKey);

    if (entry.type === 'EARN') {
      totalEarn += entry.points;
      if (cell) cell.earn += entry.points;
    } else if (entry.type === 'REDEEM') {
      totalBurn += entry.points;
      if (cell) cell.burn += entry.points;
    } else if (entry.type === 'EXPIRE') {
      totalExpired += entry.points;
    }
  }

  const closingBalance = openingBalance + totalEarn - totalBurn - totalExpired;

  return {
    ...meta,
    openingBalance,
    months: months.map((m) => cellByKey.get(m.monthKey)!),
    totalEarn,
    totalBurn,
    totalExpired,
    closingBalance,
  };
}

/**
 * Flatten points-ledger rows to xlsx row objects with dynamic per-month
 * Earn/Burn columns (header order mirrors the source generator).
 */
export function pointsLedgerXlsxRows(
  rows: PointsLedgerReportRow[],
  months: ReportMonth[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {
      'Outlet ID': row.outletId,
      'Outlet Name': row.outletName,
      'Outlet type': row.outletType ?? '',
      'Opening balance': row.openingBalance,
    };
    for (const cell of row.months) {
      out[`${cell.label} Earn`] = cell.earn;
      out[`${cell.label} Burn`] = cell.burn;
    }
    out['Total earn'] = row.totalEarn;
    out['Total burn'] = row.totalBurn;
    out['Total expired'] = row.totalExpired;
    out['Closing balance'] = row.closingBalance;
    return out;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticket Aging (R2)
// ─────────────────────────────────────────────────────────────────────────────

export const AGING_BUCKETS = [
  '0-1 days',
  '2-3 days',
  '4-7 days',
  '8-14 days',
  '15-30 days',
  '30+ days',
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

export interface TicketAgingRow {
  ticketNumber: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  createdByName: string;
  assignedToName?: string;
  createdAt: string;
  ageDays: number;
  agingBucket: AgingBucket;
  firstResponseHours: number | null;
  slaBreached: boolean;
  lastUpdatedAt: string;
}

export interface TicketAgingSummary {
  total: number;
  slaBreached: number;
  byBucket: Record<string, number>;
}

export interface TicketInput {
  ticketNumber: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  createdByName: string;
  assignedToName?: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  firstResponseAt?: Date | string | null;
  slaBreached: boolean;
}

/** Whole days between createdAt and asOf, clamped to >= 0. */
export function ageInDays(createdAt: Date | string, asOf: Date | string): number {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const as = asOf instanceof Date ? asOf : new Date(asOf);
  const diff = Math.floor((as.getTime() - created.getTime()) / 86_400_000);
  return Math.max(0, diff);
}

/** Map an age-in-days to its display bucket. */
export function agingBucket(ageDays: number): AgingBucket {
  if (ageDays <= 1) return '0-1 days';
  if (ageDays <= 3) return '2-3 days';
  if (ageDays <= 7) return '4-7 days';
  if (ageDays <= 14) return '8-14 days';
  if (ageDays <= 30) return '15-30 days';
  return '30+ days';
}

/** Hours (1-decimal) to first response, or null. Clamped to >= 0. */
export function firstResponseHours(
  firstResponseAt: Date | string | null | undefined,
  createdAt: Date | string,
): number | null {
  if (firstResponseAt == null) return null;
  const resp = firstResponseAt instanceof Date ? firstResponseAt : new Date(firstResponseAt);
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const hrs = (resp.getTime() - created.getTime()) / 3_600_000;
  return Math.max(0, Math.round(hrs * 10) / 10);
}

/** Map a raw ticket + asOf to a TicketAgingRow. Pure / deterministic. */
export function buildTicketAgingRow(t: TicketInput, asOf: Date | string): TicketAgingRow {
  const days = ageInDays(t.createdAt, asOf);
  const bucket = agingBucket(days);
  const frhrs = firstResponseHours(t.firstResponseAt, t.createdAt);
  const toISO = (d: Date | string): string =>
    (d instanceof Date ? d : new Date(d)).toISOString();

  return {
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    createdByName: t.createdByName,
    assignedToName: t.assignedToName,
    createdAt: toISO(t.createdAt),
    ageDays: days,
    agingBucket: bucket,
    firstResponseHours: frhrs,
    slaBreached: t.slaBreached,
    lastUpdatedAt: toISO(t.updatedAt),
  };
}

/** Totals + per-bucket counts; all six bucket keys always present. */
export function summarizeAging(rows: TicketAgingRow[]): TicketAgingSummary {
  const byBucket: Record<string, number> = {};
  for (const b of AGING_BUCKETS) byBucket[b] = 0;

  let slaBreachedCount = 0;
  for (const r of rows) {
    if (r.slaBreached) slaBreachedCount++;
    if (byBucket[r.agingBucket] !== undefined) byBucket[r.agingBucket]++;
  }
  return { total: rows.length, slaBreached: slaBreachedCount, byBucket };
}

const isoToDate = (iso: string): string => iso.slice(0, 10);

/** Flatten ticket-aging rows to xlsx row objects (13 columns, source order). */
export function ticketAgingXlsxRows(rows: TicketAgingRow[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    'Ticket #': r.ticketNumber,
    Subject: r.subject,
    Category: r.category,
    Priority: r.priority,
    Status: r.status,
    'Created By': r.createdByName,
    'Assigned To': r.assignedToName ?? '',
    Created: isoToDate(r.createdAt),
    'Age (days)': r.ageDays,
    'Aging bucket': r.agingBucket,
    'First response (hrs)': r.firstResponseHours === null ? 'Pending' : r.firstResponseHours,
    'SLA breached': r.slaBreached ? 'Yes' : 'No',
    'Last updated': isoToDate(r.lastUpdatedAt),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Target vs Sales Performance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Max inclusive span (in months) for the Target vs Sales report. Kept as a named
 * constant so the DTO/service message, the FE validation copy, and the tests all
 * point at one source of truth.
 */
export const TARGET_VS_SALES_MAX_MONTHS = 15;

/** A KPI column definition (from the tenant's enabled KpiDef catalogue). */
export interface TargetVsSalesKpiDef {
  code: string;
  label: string;
  unit?: string | null;
}

/**
 * The per-outlet×KPI shape produced by TargetsService.getPace — re-declared here
 * (structurally identical) so the pure row-builder can be unit-tested without the
 * targets module. `target`/`achieved`/`pace` are null when the key is ABSENT
 * (never stored) — a stored value of 0 is a real 0, NOT null.
 */
export interface PaceKpi {
  code: string;
  target: number | null;
  achieved: number | null;
  pace: number | null;
}
export interface PaceOutlet {
  outletCode: string;
  outletName: string;
  outletType: string;
  month: string;
  kpis: PaceKpi[];
}
/** getPace's output for ONE month, tagged with that month. */
export interface PaceMonthResult {
  month: string; // YYYY-MM
  outlets: PaceOutlet[];
}

/**
 * Ordered inclusive YYYY-MM list between from/to. Throws RangeError when
 * from > to or when the span exceeds TARGET_VS_SALES_MAX_MONTHS (15) — the
 * service turns either into a 400 with the RangeError's message.
 */
export function targetVsSalesMonthList(fromYYYYMM: string, toYYYYMM: string): string[] {
  const [fromYear, fromMonth] = fromYYYYMM.split('-').map(Number);
  const [toYear, toMonth] = toYYYYMM.split('-').map(Number);

  const fromTotal = fromYear * 12 + (fromMonth - 1);
  const toTotal = toYear * 12 + (toMonth - 1);

  if (fromTotal > toTotal) {
    throw new RangeError(`fromMonth (${fromYYYYMM}) must not be after toMonth (${toYYYYMM}).`);
  }

  const count = toTotal - fromTotal + 1;
  if (count > TARGET_VS_SALES_MAX_MONTHS) {
    throw new RangeError(
      `Period spans ${count} months — maximum allowed is ${TARGET_VS_SALES_MAX_MONTHS} months (inclusive).`,
    );
  }

  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const total = fromTotal + i;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    out.push(`${year}-${String(month).padStart(2, '0')}`);
  }
  return out;
}

/** The three column headers a KPI contributes, in order. */
export function targetVsSalesKpiHeaders(label: string): [string, string, string] {
  return [`${label} Target`, `${label} Achieved`, `${label} Pace %`];
}

/**
 * The full ordered header-key list for a Target vs Sales sheet: four lead columns
 * then Target/Achieved/Pace % per KPI (KpiDef order). Used to project every row
 * (so the xlsx column order is deterministic) and to seed an all-blank row when
 * there is no data (so the download still carries its headers).
 */
export function targetVsSalesHeaderKeys(kpiDefs: TargetVsSalesKpiDef[]): string[] {
  const keys = ['Outlet Code', 'Outlet Name', 'Outlet Type', 'Month'];
  for (const k of kpiDefs) keys.push(...targetVsSalesKpiHeaders(k.label));
  return keys;
}

/** pace ratio → percentage rounded to 1 decimal (e.g. 0.8753 → 87.5). */
function paceToPct(pace: number): number {
  return Math.round(pace * 1000) / 10;
}

/**
 * Build the flat (outlet × month) grid for the Target vs Sales report.
 *
 * Row set: one row per (qualifying outlet × EVERY month in range), where a
 * "qualifying" outlet is any outlet that has at least one target OR actual in the
 * range (i.e. appears in getPace for at least one month). This makes the range a
 * contiguous timeline — a month/outlet with no upload appears as a row whose KPI
 * cells are all BLANK (not 0), and a KPI with no target/actual within an
 * otherwise-present outlet-month is also BLANK. A stored value of 0 is a real 0
 * and is emitted as 0 (mirrors the upload rule "blank cells are skipped, not
 * stored as 0"). Pace % is blank whenever pace is null (target absent or 0).
 *
 * Rows are ordered by outletCode then month; KPI columns follow KpiDef order.
 * Every row carries the identical key set (targetVsSalesHeaderKeys), so
 * json_to_sheet derives a complete, stable header row.
 */
export function buildTargetVsSalesRows(
  months: string[],
  kpiDefs: TargetVsSalesKpiDef[],
  paceResults: PaceMonthResult[],
): { rows: Record<string, unknown>[]; kpis: TargetVsSalesKpiDef[]; headerKeys: string[] } {
  // Index: `${month}::${outletCode}` → (code → PaceKpi); plus outlet meta and the
  // set of qualifying outlet codes (any outlet seen in any month).
  const byMonthOutlet = new Map<string, Map<string, PaceKpi>>();
  const meta = new Map<string, { name: string; type: string }>();
  const qualifying = new Set<string>();

  for (const { month, outlets } of paceResults) {
    for (const o of outlets) {
      qualifying.add(o.outletCode);
      const kpiMap = new Map<string, PaceKpi>();
      for (const k of o.kpis) kpiMap.set(k.code, k);
      byMonthOutlet.set(`${month}::${o.outletCode}`, kpiMap);

      // Capture the friendliest meta seen (prefer a non-empty name/type).
      const prev = meta.get(o.outletCode);
      meta.set(o.outletCode, {
        name: prev?.name || o.outletName || o.outletCode,
        type: prev?.type || o.outletType || '',
      });
    }
  }

  const headerKeys = targetVsSalesHeaderKeys(kpiDefs);
  const sortedOutlets = [...qualifying].sort((a, b) => a.localeCompare(b));

  const rows: Record<string, unknown>[] = [];
  for (const outletCode of sortedOutlets) {
    const m = meta.get(outletCode) ?? { name: outletCode, type: '' };
    for (const month of months) {
      const kpiMap = byMonthOutlet.get(`${month}::${outletCode}`);
      const row: Record<string, unknown> = {
        'Outlet Code': outletCode,
        'Outlet Name': m.name,
        'Outlet Type': m.type,
        Month: month,
      };
      for (const def of kpiDefs) {
        const [tHdr, aHdr, pHdr] = targetVsSalesKpiHeaders(def.label);
        const k = kpiMap?.get(def.code);
        // Blank ('') when the KPI key is absent (null) OR the outlet-month has no
        // data at all; a real 0 stays 0.
        row[tHdr] = k && k.target !== null ? k.target : '';
        row[aHdr] = k && k.achieved !== null ? k.achieved : '';
        row[pHdr] = k && k.pace !== null ? paceToPct(k.pace) : '';
      }
      rows.push(row);
    }
  }

  return { rows, kpis: kpiDefs, headerKeys };
}
