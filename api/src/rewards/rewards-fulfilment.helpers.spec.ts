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
  FulfilmentTemplateRow,
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
    expect(aoa[0].slice(0, 6)).toEqual(['Order Number', 'Reward', 'Outlet ID', 'Phone', 'Mode', 'Current Status']);
    expect(aoa[1][2]).toBe('BJ-0042');
    expect(String(aoa[1][3])).toBe('9811111111');
    // Not recorded → blank cells, never "undefined".
    expect(aoa[2][2] ?? '').toBe('');
    expect(aoa[2][3] ?? '').toBe('');
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
