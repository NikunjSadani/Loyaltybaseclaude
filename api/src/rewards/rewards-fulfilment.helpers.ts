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
 *   Order Number | Reward | Outlet ID | Phone | Redeemed on (IST) | Outlet name | Owner name |
 *   Deliver to (name) | Delivery phone | Address line 1 | Address line 2 | City | State | PIN code |
 *   Mode | Current Status |
 *   Voucher Code | Voucher PIN | Voucher Provider | Tracking Number | Tracking URL | New Status
 *
 * The columns up to Current Status are the locked context the ops user reads (Outlet ID + Phone added
 * 2026-11-24 — ignored on upload, like the other context columns); the last six
 * are blank fill columns. `Order Number` is the row key. `Voucher PIN` is OPTIONAL (card number
 * + PIN gift cards only) and text-formatted so a leading-zero PIN survives Excel; the parser is
 * header-based, so a sheet downloaded before the column existed still uploads unchanged.
 *
 * Outlet name / Owner name + the seven DELIVERY columns (added 2026-11-24, between Redeemed on and
 * Mode) are READ-ONLY info for shipping physical gifts — never read on upload. Delivery cells are
 * filled for PHYSICAL_GIFT rows only (blank for voucher / cash rows) and only for a caller who may
 * manage orders. Phone / Delivery phone / PIN code are TEXT cells (leading zeros survive).
 */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '../common/xlsx';
import { istDateTimeCell } from '../common/ist-date';

// ── Column headers (the canonical template shape) ─────────────────────────────

export const FULFILMENT_KEY_COL = 'Order Number';

export const FULFILMENT_COLS = [
  'Order Number',
  'Reward',
  'Outlet ID',
  'Phone',
  'Redeemed on (IST)',
  'Outlet name',
  'Owner name',
  'Deliver to (name)',
  'Delivery phone',
  'Address line 1',
  'Address line 2',
  'City',
  'State',
  'PIN code',
  'Mode',
  'Current Status',
  'Voucher Code',
  'Voucher PIN',
  'Voucher Provider',
  'Tracking Number',
  'Tracking URL',
  'New Status',
] as const;

/** Fill columns that must be TEXT cells (a number cell has already lost leading zeros / digits). */
export const TEXT_FILL_COLS = ['Voucher Code', 'Voucher PIN'] as const;

/** Read-only context columns written as TEXT cells (leading zeros / long digits must survive). */
export const TEXT_CONTEXT_COLS = ['Phone', 'Delivery phone', 'PIN code'] as const;

/** Delivery address for a PHYSICAL_GIFT order (RedemptionOrder.delivery*). Read-only context. */
export interface FulfilmentDelivery {
  name?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
}

/** Row error for a Voucher Code / PIN cell Excel stored as a number. */
export const VOUCHER_CELL_NUMBER_MESSAGE =
  'Voucher Code/PIN must be entered as text — format the column as Text and re-type it';

// ── Template build ────────────────────────────────────────────────────────────

/** Minimal order shape the template needs (the locked context columns). */
export interface FulfilmentTemplateRow {
  orderNumber: string;
  reward: string;
  /** The partner's primary outlet code ('' when none). Read-only context. */
  outletCode?: string;
  /** The partner's registered mobile ('' when none). Read-only context. */
  phone?: string;
  /** When the partner placed the redemption (RedemptionOrder.createdAt) — shown in IST. */
  redeemedAt?: Date | null;
  /** The partner's primary outlet name (falls back to the business name). Read-only context. */
  outletName?: string;
  /** The outlet / partner owner name. Read-only context. */
  ownerName?: string;
  /**
   * Delivery address — set ONLY for a PHYSICAL_GIFT order AND a caller who may manage orders;
   * omitted → the delivery cells stay blank.
   */
  delivery?: FulfilmentDelivery | null;
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
    o.outletCode ?? '',
    o.phone ?? '',
    o.redeemedAt ? istDateTimeCell(o.redeemedAt) : '',
    o.outletName ?? '',
    o.ownerName ?? '',
    o.delivery?.name ?? '',
    o.delivery?.phone ?? '',
    o.delivery?.addressLine1 ?? '',
    o.delivery?.addressLine2 ?? '',
    o.delivery?.city ?? '',
    o.delivery?.state ?? '',
    o.delivery?.pincode ?? '',
    o.mode,
    o.currentStatus,
    '', // Voucher Code
    '', // Voucher PIN (optional)
    '', // Voucher Provider
    '', // Tracking Number
    '', // Tracking URL
    '', // New Status
  ]);

  const ws = aoaToSheetSafe([header, ...dataRows]);
  // Text-format the Voucher Code + PIN fill cells (Excel would otherwise turn "0123" into the
  // number 123, or a 16-digit card number into 6.001E+15 with its last digits zeroed).
  for (const label of [...TEXT_FILL_COLS, ...TEXT_CONTEXT_COLS]) {
    const col = FULFILMENT_COLS.indexOf(label);
    for (let r = 1; r <= dataRows.length; r++) {
      const ref = XLSX.utils.encode_cell({ r, c: col });
      const cellObj = ws[ref] as XLSX.CellObject | undefined;
      if (cellObj) cellObj.z = '@';
    }
  }
  ws['!cols'] = [
    { wch: 22 }, // Order Number
    { wch: 28 }, // Reward
    { wch: 16 }, // Outlet ID
    { wch: 14 }, // Phone
    { wch: 18 }, // Redeemed on (IST)
    { wch: 24 }, // Outlet name
    { wch: 20 }, // Owner name
    { wch: 20 }, // Deliver to (name)
    { wch: 14 }, // Delivery phone
    { wch: 32 }, // Address line 1
    { wch: 24 }, // Address line 2
    { wch: 16 }, // City
    { wch: 16 }, // State
    { wch: 10 }, // PIN code
    { wch: 14 }, // Mode
    { wch: 16 }, // Current Status
    { wch: 22 }, // Voucher Code
    { wch: 14 }, // Voucher PIN
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
  /** Optional card PIN (card number + PIN gift cards). */
  voucherPin?: string;
  voucherProvider?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  /** The target status the ops user wants to set; blank = no status change. */
  newStatus?: string;
  /**
   * A parse-level problem with this row (e.g. a Voucher Code / PIN cell stored as a NUMBER): the
   * caller collects it as a row error and does NOT apply the row.
   */
  error?: string;
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
    // RAW cell values (explicit, it is the default): a number cell stays a JS number so the
    // Voucher Code / PIN number-cell check below can tell it from a text cell.
    raw: true,
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
  const voucherPinCol = idxOf('Voucher PIN');
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

    // sheet_to_json is read RAW (the default), so a numeric cell arrives as a JS number while a
    // text cell (incl. a text-formatted "0123") arrives as a string. A number in the code / PIN
    // column means Excel already converted it (leading zeros dropped, long numbers rounded) — the
    // value can't be trusted, so the row is refused rather than issuing a corrupted voucher.
    const isNumberCell = (ci: number) => ci >= 0 && ci < row.length && typeof row[ci] === 'number';
    if (isNumberCell(voucherCodeCol) || isNumberCell(voucherPinCol)) {
      rows.push({ rowIndex: ri + 1, orderNumber, error: VOUCHER_CELL_NUMBER_MESSAGE });
      continue;
    }

    rows.push({
      rowIndex: ri + 1,
      orderNumber,
      voucherCode: cell(voucherCodeCol),
      voucherPin: cell(voucherPinCol),
      voucherProvider: cell(voucherProviderCol),
      trackingNumber: cell(trackingNumberCol),
      trackingUrl: cell(trackingUrlCol),
      newStatus: cell(newStatusCol),
    });
  }

  return { rows };
}
