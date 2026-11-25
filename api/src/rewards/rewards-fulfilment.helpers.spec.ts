/**
 * Unit tests for rewards-fulfilment.helpers.ts — focused on the AF-5
 * formula-injection hardening of buildFulfilmentTemplateBuffer (the WRITE/export
 * path). The parse path (parseFulfilmentUploadBuffer) is intentionally untouched.
 *
 * The fulfilment template echoes reward/order context strings into cells an ops
 * user opens in Excel, so injection-prone string cells must be neutralised.
 */

import * as XLSX from 'xlsx';
import {
  buildFulfilmentTemplateBuffer,
  FULFILMENT_README_SHEET,
  FulfilmentTemplateRow,
  MISSING_ADDRESS_TEXT,
  parseFulfilmentUploadBuffer,
} from './rewards-fulfilment.helpers';

/** Read the template sheet back as raw arrays (row0 = headers, row1+ = data). */
function readAoa(buf: Buffer): string[][] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    defval: '',
    raw: false,
  }) as string[][];
}

describe('buildFulfilmentTemplateBuffer — formula-injection sanitisation (AF-5)', () => {
  it('prefixes injection-prone string cells with an apostrophe', () => {
    const rows: FulfilmentTemplateRow[] = [
      {
        orderNumber: '=cmd|\'/c calc\'!A1',
        reward: '@SUM(A1)',
        outletCode: '=HYPERLINK("x")',
        mode: '+1+1',
        currentStatus: '-2',
      },
    ];
    const aoa = readAoa(buildFulfilmentTemplateBuffer(rows));
    const col = (h: string) => (aoa[0] as string[]).indexOf(h);
    const data = aoa[1]; // header at row 0
    expect(data[col('Order Number')]).toBe('\'=cmd|\'/c calc\'!A1');
    expect(data[col('Reward')]).toBe('\'@SUM(A1)');
    expect(data[col('Outlet ID')]).toBe('\'=HYPERLINK("x")');
    expect(data[col('Mode')]).toBe('\'+1+1');
    expect(data[col('Current Status')]).toBe('\'-2');
  });

  it('leaves a benign row unchanged', () => {
    const rows: FulfilmentTemplateRow[] = [
      { orderNumber: 'ORD-100', reward: 'Amazon Voucher', mode: 'DIGITAL', currentStatus: 'PENDING' },
    ];
    const aoa = readAoa(buildFulfilmentTemplateBuffer(rows));
    const col = (h: string) => (aoa[0] as string[]).indexOf(h);
    const data = aoa[1];
    expect(data[col('Order Number')]).toBe('ORD-100');
    expect(data[col('Reward')]).toBe('Amazon Voucher');
    expect(data[col('Mode')]).toBe('DIGITAL');
    expect(data[col('Current Status')]).toBe('PENDING');
  });
});

describe('buildFulfilmentTemplateBuffer — Outlet ID + Phone context columns', () => {
  it('emits Outlet ID and Phone right after Reward, before the fill columns', () => {
    const aoa = readAoa(
      buildFulfilmentTemplateBuffer([
        { orderNumber: 'ORD-1', reward: 'R', outletCode: 'BJ-0042', phone: '9811111111', mode: 'GIFT_CARD', currentStatus: 'CONFIRMED' },
        { orderNumber: 'ORD-2', reward: 'R', mode: 'GIFT_CARD', currentStatus: 'CONFIRMED' },
      ]),
    );
    expect(aoa[0].slice(0, 6)).toEqual(['Order Number', 'Client', 'Reward', 'Outlet ID', 'Phone', 'Redeemed on (IST)']);
    expect(aoa[1][3]).toBe('BJ-0042');
    expect(String(aoa[1][4])).toBe('9811111111');
    // Not recorded → blank cells, never "undefined".
    expect(aoa[2][3] ?? '').toBe('');
    expect(aoa[2][4] ?? '').toBe('');
  });

  it('Redeemed on = the order createdAt in IST (YYYY-MM-DD HH:mm, sortable); blank when unknown', () => {
    const aoa = readAoa(
      buildFulfilmentTemplateBuffer([
        // 10:12 UTC = 15:42 IST
        { orderNumber: 'ORD-1', reward: 'R', redeemedAt: new Date('2026-11-24T10:12:00.000Z'), mode: 'GIFT_CARD', currentStatus: 'CONFIRMED' },
        { orderNumber: 'ORD-2', reward: 'R', mode: 'GIFT_CARD', currentStatus: 'CONFIRMED' },
      ]),
    );
    const col = (aoa[0] as string[]).indexOf('Redeemed on (IST)');
    expect(aoa[1][col]).toBe('2026-11-24 15:42');
    expect(aoa[2][col] ?? '').toBe('');
  });

  it('the upload parser ignores the new context columns (a filled sheet still round-trips)', () => {
    const buf = buildFulfilmentTemplateBuffer([
      { orderNumber: 'ORD-1', reward: 'R', outletCode: 'BJ-0042', phone: '9811111111', mode: 'GIFT_CARD', currentStatus: 'CONFIRMED' },
    ]);
    const parsed = parseFulfilmentUploadBuffer(buf);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ orderNumber: 'ORD-1' });
    expect(parsed.rows[0].voucherCode).toBeUndefined();
  });
});

describe('fulfilment sheet — outlet / owner + delivery address columns (2026-11-24)', () => {
  const DELIVERY_COLS = ['Deliver to (name)', 'Delivery phone', 'Address line 1', 'Address line 2', 'City', 'State', 'PIN code'];

  it('places the 9 new columns after Redeemed on and before Mode; physical row filled, voucher row blank', () => {
    const aoa = readAoa(
      buildFulfilmentTemplateBuffer([
        {
          orderNumber: 'PHY-1', reward: 'Cooker', outletName: 'Outlet One', ownerName: 'Ravi', mode: 'PHYSICAL_GIFT', currentStatus: 'CONFIRMED',
          delivery: { name: 'Ravi Kumar', phone: '09822222222', addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', state: 'Maharashtra', pincode: '011001' },
        },
        { orderNumber: 'GC-1', reward: 'Amazon', outletName: 'Outlet Two', ownerName: 'Asha', mode: 'GIFT_CARD', currentStatus: 'CONFIRMED' },
      ]),
    );
    expect(aoa[0].slice(0, 16)).toEqual([
      'Order Number', 'Client', 'Reward', 'Outlet ID', 'Phone', 'Redeemed on (IST)',
      'Outlet name', 'Owner name', ...DELIVERY_COLS, 'Mode',
    ]);
    const col = (h: string) => aoa[0].indexOf(h);
    expect(DELIVERY_COLS.map((c) => aoa[1][col(c)])).toEqual([
      'Ravi Kumar', '09822222222', '12 MG Road', '', 'Pune', 'Maharashtra', '011001',
    ]);
    expect(aoa[2][col('Outlet name')]).toBe('Outlet Two');
    expect(aoa[2][col('Owner name')]).toBe('Asha');
    expect(DELIVERY_COLS.map((c) => aoa[2][col(c)] ?? '')).toEqual(['', '', '', '', '', '', '']);
  });

  it('PIN code / Delivery phone / Phone are TEXT cells (leading zeros survive)', () => {
    const buf = buildFulfilmentTemplateBuffer([
      { orderNumber: 'PHY-1', reward: 'C', phone: '0981111111', mode: 'PHYSICAL_GIFT', currentStatus: 'CONFIRMED', delivery: { phone: '09822222222', pincode: '011001' } },
    ]);
    const ws = XLSX.read(buf, { type: 'buffer' }).Sheets.Fulfilment;
    const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true }) as unknown[][];
    const h = raw[0] as string[];
    for (const [label, v] of [['PIN code', '011001'], ['Delivery phone', '09822222222'], ['Phone', '0981111111']] as const) {
      const cell = ws[XLSX.utils.encode_cell({ r: 1, c: h.indexOf(label) })];
      expect(cell.t).toBe('s');
      expect(cell.v).toBe(v);
    }
  });

  it('escapes formula-leading delivery text', () => {
    const aoa = readAoa(buildFulfilmentTemplateBuffer([
      { orderNumber: 'PHY-1', reward: 'C', mode: 'PHYSICAL_GIFT', currentStatus: 'CONFIRMED', outletName: '+SUM(1)', delivery: { name: '@x', addressLine1: '=1+1', city: '-3' } },
    ]));
    const col = (h: string) => aoa[0].indexOf(h);
    expect(aoa[1][col('Outlet name')]).toBe('\'+SUM(1)');
    expect(aoa[1][col('Deliver to (name)')]).toBe('\'@x');
    expect(aoa[1][col('Address line 1')]).toBe('\'=1+1');
    expect(aoa[1][col('City')]).toBe('\'-3');
  });

  it('upload ignores the new read-only columns: a filled NEW sheet applies only the fill columns', () => {
    const wb = XLSX.read(buildFulfilmentTemplateBuffer([
      { orderNumber: 'PHY-1', reward: 'C', mode: 'PHYSICAL_GIFT', currentStatus: 'CONFIRMED', outletName: 'O', ownerName: 'W',
        delivery: { name: 'N', phone: '9822222222', addressLine1: 'A1', city: 'Pune', state: 'MH', pincode: '411001' } },
    ]), { type: 'buffer' });
    const ws = wb.Sheets.Fulfilment;
    const h = (XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 })[0]) as string[];
    // The ops user edits an address cell + the Client cell (ignored) and fills tracking + New Status.
    ws[XLSX.utils.encode_cell({ r: 1, c: h.indexOf('Address line 1') })] = { t: 's', v: 'EDITED' };
    ws[XLSX.utils.encode_cell({ r: 1, c: h.indexOf('Client') })] = { t: 's', v: 'other-tenant' };
    ws[XLSX.utils.encode_cell({ r: 1, c: h.indexOf('Tracking Number') })] = { t: 's', v: 'TRK-9' };
    ws[XLSX.utils.encode_cell({ r: 1, c: h.indexOf('New Status') })] = { t: 's', v: 'DISPATCHED' };
    const { rows } = parseFulfilmentUploadBuffer(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    expect(rows).toEqual([{
      rowIndex: 2, orderNumber: 'PHY-1', voucherCode: undefined, voucherPin: undefined, voucherProvider: undefined,
      trackingNumber: 'TRK-9', trackingUrl: undefined, newStatus: 'DISPATCHED',
    }]);
  });

  it('Client column sits right after Order Number and is filled', () => {
    const aoa = readAoa(buildFulfilmentTemplateBuffer([
      { orderNumber: 'O-1', client: 'Bajaj Almond Drops', reward: 'R', mode: 'GIFT_CARD', currentStatus: 'CONFIRMED' },
    ]));
    expect(aoa[0][1]).toBe('Client');
    expect(aoa[1][1]).toBe('Bajaj Almond Drops');
  });

  it('MISSING marker only when a physical order has neither an address line nor a PIN; partial addresses are written as-is', () => {
    const aoa = readAoa(buildFulfilmentTemplateBuffer([
      { orderNumber: 'P-NONE', reward: 'C', mode: 'PHYSICAL_GIFT', currentStatus: 'CONFIRMED', delivery: { name: 'N', addressLine1: ' ', pincode: null } },
      { orderNumber: 'P-NOPIN', reward: 'C', mode: 'PHYSICAL_GIFT', currentStatus: 'CONFIRMED', delivery: { addressLine1: '12 MG Road' } },
      { orderNumber: 'P-NOLINE', reward: 'C', mode: 'PHYSICAL_GIFT', currentStatus: 'CONFIRMED', delivery: { pincode: '411001' } },
      { orderNumber: 'GC', reward: 'C', mode: 'GIFT_CARD', currentStatus: 'CONFIRMED' },
    ]));
    const a1 = aoa[0].indexOf('Address line 1');
    const pin = aoa[0].indexOf('PIN code');
    expect(aoa[1][a1]).toBe(MISSING_ADDRESS_TEXT);
    expect(aoa[2][a1]).toBe('12 MG Road');
    expect(aoa[2][pin] ?? '').toBe('');
    expect(aoa[3][a1] ?? '').toBe('');
    expect(aoa[3][pin]).toBe('411001');
    expect(aoa[4][a1] ?? '').toBe('');
  });

  it('adds a second "Read me" sheet; the parser reads ONLY the first sheet', () => {
    const buf = buildFulfilmentTemplateBuffer([
      { orderNumber: 'O-1', reward: 'R', mode: 'GIFT_CARD', currentStatus: 'CONFIRMED' },
    ]);
    const wb = XLSX.read(buf, { type: 'buffer' });
    expect(wb.SheetNames).toEqual(['Fulfilment', FULFILMENT_README_SHEET]);
    const text = JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets[FULFILMENT_README_SHEET], { header: 1 }));
    expect(text).toMatch(/NOT saved/);
    expect(text).toMatch(/Tracking Number, Tracking URL, New Status/);
    // Put an "Order Number" table on the Read me sheet — it must never be parsed.
    XLSX.utils.sheet_add_aoa(wb.Sheets[FULFILMENT_README_SHEET], [['Order Number', 'New Status'], ['EVIL-1', 'CANCELLED']], { origin: 'A20' });
    const { rows } = parseFulfilmentUploadBuffer(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    expect(rows.map((r) => r.orderNumber)).toEqual(['O-1']);
  });

  it('a sheet downloaded BEFORE this change (old 13-column layout) still uploads unchanged', () => {
    const OLD_COLS = [
      'Order Number', 'Reward', 'Outlet ID', 'Phone', 'Redeemed on (IST)', 'Mode', 'Current Status',
      'Voucher Code', 'Voucher PIN', 'Voucher Provider', 'Tracking Number', 'Tracking URL', 'New Status',
    ];
    const ws = XLSX.utils.aoa_to_sheet([
      OLD_COLS,
      ['PHY-1', 'Cooker', 'BJ-1', '9811111111', '2026-11-20 10:00', 'PHYSICAL_GIFT', 'CONFIRMED', '', '', '', 'TRK-1', 'https://t/1', 'DISPATCHED'],
      ['GC-1', 'Amazon', 'BJ-2', '9811111112', '2026-11-20 10:00', 'GIFT_CARD', 'CONFIRMED', 'CODE-1', '0123', 'Amazon', '', '', 'DELIVERED'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Fulfilment');
    const { rows } = parseFulfilmentUploadBuffer(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
    expect(rows).toEqual([
      { rowIndex: 2, orderNumber: 'PHY-1', voucherCode: undefined, voucherPin: undefined, voucherProvider: undefined, trackingNumber: 'TRK-1', trackingUrl: 'https://t/1', newStatus: 'DISPATCHED' },
      { rowIndex: 3, orderNumber: 'GC-1', voucherCode: 'CODE-1', voucherPin: '0123', voucherProvider: 'Amazon', trackingNumber: undefined, trackingUrl: undefined, newStatus: 'DELIVERED' },
    ]);
  });
});
