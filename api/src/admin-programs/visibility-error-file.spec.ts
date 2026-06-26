/**
 * Focused AF-5 spec for the visibility bulk-upload ERROR file writer.
 *
 * visibility.service.ts → bulkUpload() builds an error workbook from the rejected
 * rows via `aoaToSheetSafe([errHeaders, ...errData])`. Those rows echo
 * user-uploaded values (outlet_id, captured_by_employee_name, error_remarks) into
 * a sheet the admin re-opens in Excel — a formula-injection sink. This test
 * reproduces that exact build (same headers + a crafted error row) and asserts the
 * echoed string cells are neutralised, while a benign value passes through.
 *
 * (The full bulkUpload path needs Prisma DI; this isolates the sanitised writer
 * the service delegates to, mirroring the inline `[errHeaders, ...errData]` build.)
 */

import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '../common/xlsx';

// Mirrors the errHeaders array in visibility.service.ts bulkUpload().
const ERR_HEADERS = [
  'row_number', 'outlet_id', 'month', 'status', 'date_of_capture',
  'approved_by', 'captured_by_employee_id', 'captured_by_employee_name',
  'captured_by_employee_phone', 'error_remarks',
];

/** Build the error sheet exactly as the service does, then read it back. */
function buildAndRead(errData: unknown[][]): string[][] {
  const ws = aoaToSheetSafe([ERR_HEADERS, ...errData]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Errors');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const rwb = XLSX.read(buf, { type: 'buffer' });
  const rws = rwb.Sheets[rwb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<string[]>(rws, { header: 1, defval: '', raw: false }) as string[][];
}

describe('visibility bulk-upload error file — formula-injection sanitisation (AF-5)', () => {
  it('neutralises injection in echoed upload values', () => {
    const aoa = buildAndRead([
      [
        2,
        '=cmd|\'/c calc\'!A1', // outlet_id (from the uploaded file)
        '2026-06',
        'CAPTURED',
        '2026-06-01',
        '@approver',
        '+empid',
        '-Evil Employee', // captured_by_employee_name
        '9820100001',
        'Outlet not found', // error_remarks (benign)
      ],
    ]);
    const data = aoa[1]; // header at row 0
    expect(data[1]).toBe('\'=cmd|\'/c calc\'!A1'); // outlet_id
    expect(data[5]).toBe('\'@approver'); // approved_by
    expect(data[6]).toBe('\'+empid'); // captured_by_employee_id
    expect(data[7]).toBe('\'-Evil Employee'); // captured_by_employee_name
    expect(data[9]).toBe('Outlet not found'); // error_remarks unchanged
  });
});
