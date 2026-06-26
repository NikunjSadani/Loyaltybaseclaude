/**
 * rewards-fulfilment.helpers.ts — pure, unit-testable Excel parse/build helpers
 * for the P5.4b BULK FULFILMENT flow (Gifsy-ops download → fill → upload),
 * mirroring the payout/target download→fill→upload pattern.
 *
 * Free of Prisma / NestJS imports so they can be tested directly without
 * bootstrapping the DI container. The service composes these with the existing
 * guarded `transitionOrder` (one call per row) so no status logic lives here.
 *
 * Layout (single header row, then one row per order):
 *   Order Number | Reward | Mode | Current Status |
 *   Voucher Code | Voucher Provider | Tracking Number | Tracking URL | New Status
 *
 * The first four columns are the locked context the ops user reads; the last five
 * are blank fill columns. `Order Number` is the row key.
 */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '../common/xlsx';

// ── Column headers (the canonical template shape) ─────────────────────────────

export const FULFILMENT_KEY_COL = 'Order Number';

export const FULFILMENT_COLS = [
  'Order Number',
  'Reward',
  'Mode',
  'Current Status',
  'Voucher Code',
  'Voucher Provider',
  'Tracking Number',
  'Tracking URL',
  'New Status',
] as const;

// ── Template build ────────────────────────────────────────────────────────────

/** Minimal order shape the template needs (the locked context columns). */
export interface FulfilmentTemplateRow {
  orderNumber: string;
  reward: string;
  mode: string;
  currentStatus: string;
}

/**
 * Build a downloadable .xlsx of orders awaiting fulfilment. The fill columns
 * (voucher / tracking / New Status) are emitted blank for the ops user.
 */
export function buildFulfilmentTemplateBuffer(orders: FulfilmentTemplateRow[]): Buffer {
  const header: string[] = [...FULFILMENT_COLS];
  const dataRows = orders.map((o) => [
    o.orderNumber,
    o.reward,
    o.mode,
    o.currentStatus,
    '', // Voucher Code
    '', // Voucher Provider
    '', // Tracking Number
    '', // Tracking URL
    '', // New Status
  ]);

  const ws = aoaToSheetSafe([header, ...dataRows]);
  ws['!cols'] = [
    { wch: 22 }, // Order Number
    { wch: 28 }, // Reward
    { wch: 14 }, // Mode
    { wch: 16 }, // Current Status
    { wch: 22 }, // Voucher Code
    { wch: 18 }, // Voucher Provider
    { wch: 20 }, // Tracking Number
    { wch: 28 }, // Tracking URL
    { wch: 16 }, // New Status
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Fulfilment');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ── Upload parse ──────────────────────────────────────────────────────────────

/** One parsed fill row — all fill values normalised to undefined when blank. */
export interface ParsedFulfilmentRow {
  /** 1-based row number for user-facing error messages (1 = header). */
  rowIndex: number;
  orderNumber: string;
  voucherCode?: string;
  voucherProvider?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  /** The target status the ops user wants to set; blank = no status change. */
  newStatus?: string;
}

export interface ParseFulfilmentResult {
  rows: ParsedFulfilmentRow[];
}

/**
 * Parse an uploaded fulfilment .xlsx. Rejects (throws) a non-template / wrong
 * shape: a missing `Order Number` header or a sheet with no data rows (<2 rows)
 * — matching the P4 parser's non-template rejection.
 *
 * Rows whose `Order Number` cell is blank are skipped (trailing empty rows).
 */
export function parseFulfilmentUploadBuffer(buffer: Buffer | ArrayBuffer): ParseFulfilmentResult {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  if (wb.SheetNames.length === 0) {
    throw new Error('Unrecognized file: no worksheet found');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rawAoa = XLSX.utils.sheet_to_json<(string | number | null | undefined)[]>(ws, {
    header: 1,
    defval: null,
  });

  // A valid template always has the header row plus at least one data row.
  if (rawAoa.length < 2) {
    throw new Error(
      'Unrecognized file: expected the fulfilment template (missing header / data rows)',
    );
  }

  const headerRow = (rawAoa[0] as (string | number | null)[]).map((c) =>
    String(c ?? '').trim(),
  );
  const idxOf = (label: string) => headerRow.indexOf(label);

  const orderCol = idxOf(FULFILMENT_KEY_COL);
  if (orderCol === -1) {
    throw new Error(`Unrecognized template: missing the required "${FULFILMENT_KEY_COL}" column`);
  }

  const voucherCodeCol = idxOf('Voucher Code');
  const voucherProviderCol = idxOf('Voucher Provider');
  const trackingNumberCol = idxOf('Tracking Number');
  const trackingUrlCol = idxOf('Tracking URL');
  const newStatusCol = idxOf('New Status');

  const rows: ParsedFulfilmentRow[] = [];

  for (let ri = 1; ri < rawAoa.length; ri++) {
    const row = rawAoa[ri] as (string | number | null | undefined)[];
    if (!row || row.every((c) => c === null || c === undefined || String(c).trim() === '')) {
      continue; // fully-blank row
    }

    const cell = (ci: number): string | undefined => {
      if (ci < 0 || ci >= row.length) return undefined;
      const v = String(row[ci] ?? '').trim();
      return v === '' ? undefined : v;
    };

    const orderNumber = cell(orderCol);
    if (!orderNumber) continue; // skip rows with no key

    rows.push({
      rowIndex: ri + 1,
      orderNumber,
      voucherCode: cell(voucherCodeCol),
      voucherProvider: cell(voucherProviderCol),
      trackingNumber: cell(trackingNumberCol),
      trackingUrl: cell(trackingUrlCol),
      newStatus: cell(newStatusCol),
    });
  }

  return { rows };
}
