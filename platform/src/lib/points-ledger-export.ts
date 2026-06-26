/**
 * Outlet Points Ledger Export
 *
 * Pure, deterministic functions for the R1 Outlet Points Ledger report.
 * Generates per-outlet points movement over a user-selected period (max 24 months)
 * with dynamic per-month Earn/Burn columns.
 *
 * Spec: docs/plans/REPORTING-REVAMP.md § R1
 */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';
import type { PointsLedgerReportRow, PointsLedgerMonthCell } from '@/types';

// ─── Month range ──────────────────────────────────────────────────────────────

/** Short month names in order, used for label generation. */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Returns the ordered list of months between `fromYYYYMM` and `toYYYYMM` (inclusive).
 *
 * @param fromYYYYMM  Start month, e.g. '2026-01'
 * @param toYYYYMM    End month,   e.g. '2026-06'
 *
 * @throws {RangeError} if from > to, or if the span exceeds 24 months (inclusive).
 */
export function monthsInRange(
  fromYYYYMM: string,
  toYYYYMM:   string,
): { monthKey: string; label: string }[] {
  // Parse into year + 0-based month index
  const [fromYear, fromMonth] = fromYYYYMM.split('-').map(Number);
  const [toYear,   toMonth  ] = toYYYYMM  .split('-').map(Number);

  const fromTotal = fromYear * 12 + (fromMonth - 1);
  const toTotal   = toYear   * 12 + (toMonth   - 1);

  if (fromTotal > toTotal) {
    throw new RangeError(`from (${fromYYYYMM}) must not be after to (${toYYYYMM})`);
  }

  const count = toTotal - fromTotal + 1;
  if (count > 24) {
    throw new RangeError(
      `Period spans ${count} months — maximum allowed is 24 months (inclusive).`,
    );
  }

  const result: { monthKey: string; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    const total = fromTotal + i;
    const year  = Math.floor(total / 12);
    const month = (total % 12) + 1; // 1-based
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const label    = `${MONTH_NAMES[month - 1]} ${year}`;
    result.push({ monthKey, label });
  }
  return result;
}

// ─── Aggregation ──────────────────────────────────────────────────────────────

/** Minimal meta required to build a row (the P2/P4 columns are optional). */
export interface OutletMeta {
  outletId:         string;
  outletName:       string;
  zone?:            string;
  znmId?:           string;
  rsmId?:           string;
  asmId?:           string;
  soId?:            string;
  xsrId?:           string;
  distributorCode?: string;
  distributorName?: string;
  programName?:     string;
  programCategory?: string;
  outletType?:      string;
}

/** One ledger entry (from PointsLedger) normalised for aggregation. */
export interface LedgerEntry {
  type:      string;     // 'EARN' | 'REDEEM' | 'EXPIRE' | other
  points:    number;
  createdAt: Date | string;
}

/**
 * Aggregates raw ledger entries into a `PointsLedgerReportRow`.
 *
 * Only EARN, REDEEM, and EXPIRE types are used; ADJUST/REVERSE/LOCK/UNLOCK
 * are excluded from totals — deferred refinement, noted per spec.
 *
 * @param meta            Static outlet metadata
 * @param openingBalance  Net points balance before the period start
 * @param entries         Raw ledger entries (all types; function filters internally)
 * @param months          Ordered month list from `monthsInRange`
 */
export function aggregateLedgerToRow(
  meta:            OutletMeta,
  openingBalance:  number,
  entries:         LedgerEntry[],
  months:          { monthKey: string; label: string }[],
): PointsLedgerReportRow {
  // Build a lookup map monthKey → cell for O(1) bucket assignment
  const cellByKey = new Map<string, PointsLedgerMonthCell>();
  for (const m of months) {
    cellByKey.set(m.monthKey, { monthKey: m.monthKey, label: m.label, earn: 0, burn: 0 });
  }

  let totalEarn    = 0;
  let totalBurn    = 0;
  let totalExpired = 0;

  for (const entry of entries) {
    const d         = entry.createdAt instanceof Date ? entry.createdAt : new Date(entry.createdAt);
    const year      = d.getUTCFullYear();
    const month     = d.getUTCMonth() + 1; // 1-based
    const monthKey  = `${year}-${String(month).padStart(2, '0')}`;
    const cell      = cellByKey.get(monthKey);

    // NOTE: ADJUST/REVERSE/LOCK/UNLOCK are excluded here — deferred refinement.
    // When those types are added, revisit whether ADJUST/REVERSE affect totals
    // or should be separate columns.
    if (entry.type === 'EARN') {
      totalEarn += entry.points;
      if (cell) cell.earn += entry.points;
    } else if (entry.type === 'REDEEM') {
      totalBurn += entry.points;
      if (cell) cell.burn += entry.points;
    } else if (entry.type === 'EXPIRE') {
      totalExpired += entry.points;
      // Expired points are not bucketed into monthly earn/burn columns per spec.
    }
  }

  const closingBalance = openingBalance + totalEarn - totalBurn - totalExpired;

  return {
    ...meta,
    openingBalance,
    months: months.map(m => cellByKey.get(m.monthKey)!),
    totalEarn,
    totalBurn,
    totalExpired,
    closingBalance,
  };
}

// ─── Excel generator ──────────────────────────────────────────────────────────

/**
 * Total count of non-per-month columns:
 *   14 leading fixed columns + 4 trailing total/closing columns = 18
 *
 * Used in tests: assert header.length === POINTS_LEDGER_FIXED_COLUMN_COUNT + 2 * months.length
 */
export const POINTS_LEDGER_FIXED_COLUMN_COUNT = 18;

// Leading fixed column labels (14)
const FIXED_LEADING_LABELS = [
  'Outlet ID',
  'Outlet Name',
  'Zone',
  'ZNM id',
  'RSM id',
  'ASM id',
  'SO id',
  'XSR id',
  'Distributor code',
  'Distributor Name',
  'Program name',
  'Program category',
  'Outlet type',
  'Opening balance',
];

// Trailing fixed column labels (4)
const FIXED_TRAILING_LABELS = [
  'Total earn',
  'Total burn',
  'Total expired',
  'Closing balance',
];

/**
 * Generates an Excel workbook with dynamic per-month Earn/Burn columns.
 *
 * Column order (per spec):
 *   Outlet ID · Outlet Name · Zone · ZNM id · RSM id · ASM id · SO id · XSR id ·
 *   Distributor code · Distributor Name · Program name · Program category · Outlet type ·
 *   Opening balance · [<Mon YYYY> Earn · <Mon YYYY> Burn] × N ·
 *   Total earn · Total burn · Total expired · Closing balance
 *
 * Returns a `Uint8Array` (same Buffer→Uint8Array wrap as outlet-master-export).
 */
export function generatePointsLedgerExcel(
  rows:   PointsLedgerReportRow[],
  months: { monthKey: string; label: string }[],
): Uint8Array {
  const wb = XLSX.utils.book_new();

  // ── Build header row ──
  const monthHeaders: string[] = [];
  for (const m of months) {
    monthHeaders.push(`${m.label} Earn`, `${m.label} Burn`);
  }
  const headerRow = [...FIXED_LEADING_LABELS, ...monthHeaders, ...FIXED_TRAILING_LABELS];

  // ── Build data rows ──
  const dataRows: (string | number)[][] = rows.map(row => {
    const leading: (string | number)[] = [
      row.outletId,
      row.outletName,
      row.zone            ?? '',
      row.znmId           ?? '',
      row.rsmId           ?? '',
      row.asmId           ?? '',
      row.soId            ?? '',
      row.xsrId           ?? '',
      row.distributorCode ?? '',
      row.distributorName ?? '',
      row.programName     ?? '',
      row.programCategory ?? '',
      row.outletType      ?? '',
      row.openingBalance,
    ];

    const monthCells: number[] = [];
    for (const cell of row.months) {
      monthCells.push(cell.earn, cell.burn);
    }

    const trailing: number[] = [
      row.totalEarn,
      row.totalBurn,
      row.totalExpired,
      row.closingBalance,
    ];

    return [...leading, ...monthCells, ...trailing];
  });

  const wsData = [headerRow, ...dataRows];
  const ws = aoaToSheetSafe(wsData);

  // ── Column widths ──
  ws['!cols'] = headerRow.map(label => ({ wch: Math.max(label.length + 2, 14) }));

  XLSX.utils.book_append_sheet(wb, ws, 'Points Ledger');

  // type: 'buffer' returns a Node.js Buffer. Wrap in Uint8Array so instanceof
  // checks pass across jsdom / Vitest realms (mirrors outlet-master-export).
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

// ─── Demo data ────────────────────────────────────────────────────────────────

/**
 * ~8 deterministic demo rows reusing the same outlets as outlet-master demo data.
 * Hierarchy, distributor, program, and outletType are fully populated for client
 * look-and-feel sign-off. Per-month earn/burn values are a pure deterministic
 * function of (outlet index, month index) — NO randomness.
 *
 * Opening balances are chosen so that closing balance stays non-negative.
 */
export function demoPointsLedgerRows(
  months: { monthKey: string; label: string }[],
): PointsLedgerReportRow[] {
  // Static outlet metadata mirroring outlet-master demo rows
  const DEMO_OUTLETS: OutletMeta[] = [
    {
      outletId:         'OUT-2026-K01',
      outletName:       'Kumar General Store',
      zone:             'West',
      znmId:            'ZNM-W01',
      rsmId:            'RSM-MH01',
      asmId:            'ASM-W01',
      soId:             'SO-M01',
      xsrId:            'XSR-M001',
      distributorCode:  'DIST-01',
      distributorName:  'Mumbai Distributors Pvt Ltd',
      programName:      'Trade Loyalty',
      programCategory:  'Standard',
      outletType:       'SSS',
    },
    {
      outletId:         'OUT-2026-K04',
      outletName:       'Singh Supermart',
      zone:             'West',
      znmId:            'ZNM-W01',
      rsmId:            'RSM-MH01',
      asmId:            'ASM-W01',
      soId:             'SO-M01',
      xsrId:            'XSR-M001',
      distributorCode:  'DIST-01',
      distributorName:  'Mumbai Distributors Pvt Ltd',
      programName:      'Trade Loyalty',
      programCategory:  'Premium',
      outletType:       'WHOLESALER',
    },
    {
      outletId:         'OUT-2026-K10',
      outletName:       'Sharma General Store',
      zone:             'North',
      znmId:            'ZNM-N01',
      rsmId:            'RSM-DL01',
      asmId:            'ASM-N01',
      soId:             'SO-D01',
      xsrId:            'XSR-P001',
      distributorCode:  'DIST-03',
      distributorName:  'Delhi Distributors Ltd',
      programName:      'Trade Loyalty',
      programCategory:  'Standard',
      outletType:       'SSS',
    },
    {
      outletId:         'OUT-2026-K02',
      outletName:       'Sharma Kirana',
      zone:             'West',
      znmId:            'ZNM-W01',
      rsmId:            'RSM-MH01',
      asmId:            'ASM-W01',
      soId:             'SO-M01',
      xsrId:            'XSR-M001',
      distributorCode:  'DIST-01',
      distributorName:  'Mumbai Distributors Pvt Ltd',
      programName:      'Trade Loyalty',
      programCategory:  'Standard',
      outletType:       'SSS',
    },
    {
      outletId:         'OUT-2026-K05',
      outletName:       'Mehta Provisions',
      zone:             'West',
      znmId:            'ZNM-W01',
      rsmId:            'RSM-MH01',
      asmId:            'ASM-W01',
      soId:             'SO-M01',
      xsrId:            'XSR-M001',
      distributorCode:  'DIST-02',
      distributorName:  'Suburban Distributors',
      programName:      'Trade Loyalty',
      programCategory:  'Economy',
      outletType:       'SUB_STOCKIST',
    },
    {
      outletId:         'OUT-2026-K11',
      outletName:       'Krishnamurthy & Sons',
      zone:             'South',
      znmId:            'ZNM-S01',
      rsmId:            'RSM-KA01',
      asmId:            'ASM-S01',
      soId:             'SO-B01',
      xsrId:            'XSR-P001',
      distributorCode:  'DIST-05',
      distributorName:  'Karnataka Wholesale',
      programName:      'Gold Programme',
      programCategory:  'Premium',
      outletType:       'WHOLESALER',
    },
    {
      outletId:         'OUT-2026-K12',
      outletName:       'Reddy Wholesale',
      zone:             'South',
      znmId:            'ZNM-S01',
      rsmId:            'RSM-TS01',
      asmId:            'ASM-T01',
      soId:             'SO-H01',
      xsrId:            'XSR-H001',
      distributorCode:  'DIST-06',
      distributorName:  'Telangana Wholesale',
      programName:      'Gold Programme',
      programCategory:  'Premium',
      outletType:       'WHOLESALER',
    },
    {
      outletId:         'OUT-2026-001',
      outletName:       'Verma Traders',
      zone:             'West',
      znmId:            'ZNM-W01',
      rsmId:            'RSM-MH01',
      asmId:            'ASM-W01',
      soId:             'SO-M01',
      xsrId:            'XSR-M001',
      distributorCode:  'DIST-01',
      distributorName:  'Mumbai Distributors Pvt Ltd',
      programName:      'Trade Loyalty',
      programCategory:  'Standard',
      outletType:       'SSS',
    },
  ];

  // Opening balances chosen so closingBalance stays non-negative
  const OPENING_BALANCES = [500, 1200, 300, 750, 200, 2500, 1800, 400];

  return DEMO_OUTLETS.map((meta, oi) => {
    // Deterministic earn/burn per month: function of outlet index + month index only.
    // No randomness — calling twice with the same months yields identical output.
    const cells: PointsLedgerMonthCell[] = months.map((m, mi) => {
      // earn = base value derived purely from outlet + month indices
      const earn = ((oi + 1) * 50) + ((mi + 1) * 30) + (oi * 7);
      // burn = 0 for month 0; thereafter a smaller deterministic fraction
      const burn = mi === 0 ? 0 : ((oi + 1) * 20) + (mi * 10);
      return { monthKey: m.monthKey, label: m.label, earn, burn };
    });

    const totalEarn    = cells.reduce((s, c) => s + c.earn, 0);
    const totalBurn    = cells.reduce((s, c) => s + c.burn, 0);
    const totalExpired = (oi % 3 === 0) ? (oi + 1) * 10 : 0; // deterministic, non-random
    const openingBalance = OPENING_BALANCES[oi];
    const closingBalance = openingBalance + totalEarn - totalBurn - totalExpired;

    return {
      ...meta,
      openingBalance,
      months: cells,
      totalEarn,
      totalBurn,
      totalExpired,
      closingBalance,
    };
  });
}
