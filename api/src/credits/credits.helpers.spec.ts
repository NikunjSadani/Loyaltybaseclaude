/**
 * Unit tests for credits.helpers.ts — focused on the AF-5 formula-injection
 * hardening of generatePayoutFileBuffer (the only WRITE/export path here; the
 * parseUtrUpload reader is a parse path and intentionally untouched).
 *
 * The payout file echoes user/data strings (outlet name, bank name, IFSC, UPI,
 * etc.) into cells that a payments operator opens in Excel, so every string cell
 * must be neutralised against `=,+,-,@`-prefixed formula injection.
 */

import * as XLSX from 'xlsx';
import { generatePayoutFileBuffer, PayoutBatch, PayoutBatchRow } from './credits.helpers';

const row = (over: Partial<PayoutBatchRow> = {}): PayoutBatchRow => ({
  outletId: 'OUT-1',
  outletName: 'Kumar Store',
  phone: '9820100001',
  bankName: 'HDFC',
  accountNumber: '50100123',
  ifscCode: 'HDFC0001',
  upiId: 'kumar@hdfc',
  kycStatus: 'VERIFIED',
  amount: 1500,
  isDeactivated: false,
  utrStatus: 'PENDING',
  entryIds: ['e1'],
  ...over,
});

const batch = (rows: PayoutBatchRow[]): PayoutBatch => ({
  id: 'BATCH-1',
  creditBatchId: 'CB-1',
  period: '2026-06',
  groupType: 'STANDARD',
  status: 'DOWNLOADED',
  downloadedAt: '2026-06-26',
  downloadedBy: 'admin',
  totalAmount: 1500,
  bankSnapshots: [],
  rows,
});

/** Read the payout sheet back as raw arrays (row0 = title, row1 = headers, row2+ = data). */
function readAoa(buf: Buffer): (string | number)[][] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<(string | number)[]>(ws, {
    header: 1,
    defval: '',
    raw: false,
  }) as (string | number)[][];
}

describe('generatePayoutFileBuffer — formula-injection sanitisation (AF-5)', () => {
  it('prefixes injection-prone string cells with an apostrophe', () => {
    const aoa = readAoa(
      generatePayoutFileBuffer(
        batch([
          row({
            outletName: '=cmd|\'/c calc\'!A1',
            bankName: '@SUM(A1)',
            upiId: '+1+1',
            ifscCode: '-2',
          }),
        ]),
      ),
    );
    // Data row is index 2 (title row 0, headers row 1).
    const data = aoa[2];
    // Columns: BatchID, OutletID, OutletName, Phone, BankName, Acct, IFSC, UPI, ...
    expect(data[2]).toBe('\'=cmd|\'/c calc\'!A1'); // Outlet Name
    expect(data[4]).toBe('\'@SUM(A1)'); // Bank Name
    expect(data[6]).toBe('\'-2'); // IFSC
    expect(data[7]).toBe('\'+1+1'); // UPI ID
  });

  it('leaves benign strings and the numeric amount unchanged', () => {
    const aoa = readAoa(generatePayoutFileBuffer(batch([row({ amount: 2500 })])));
    const data = aoa[2];
    expect(data[2]).toBe('Kumar Store'); // Outlet Name unchanged
    expect(data[4]).toBe('HDFC'); // Bank Name unchanged
    expect(data[10]).toBe('2500'); // Payout Amount (raw:false → string "2500")
  });
});
