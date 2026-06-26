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
        mode: '+1+1',
        currentStatus: '-2',
      },
    ];
    const aoa = readAoa(buildFulfilmentTemplateBuffer(rows));
    const data = aoa[1]; // header at row 0
    expect(data[0]).toBe('\'=cmd|\'/c calc\'!A1'); // Order Number
    expect(data[1]).toBe('\'@SUM(A1)'); // Reward
    expect(data[2]).toBe('\'+1+1'); // Mode
    expect(data[3]).toBe('\'-2'); // Current Status
  });

  it('leaves a benign row unchanged', () => {
    const rows: FulfilmentTemplateRow[] = [
      { orderNumber: 'ORD-100', reward: 'Amazon Voucher', mode: 'DIGITAL', currentStatus: 'PENDING' },
    ];
    const aoa = readAoa(buildFulfilmentTemplateBuffer(rows));
    const data = aoa[1];
    expect(data[0]).toBe('ORD-100');
    expect(data[1]).toBe('Amazon Voucher');
    expect(data[2]).toBe('DIGITAL');
    expect(data[3]).toBe('PENDING');
  });
});
