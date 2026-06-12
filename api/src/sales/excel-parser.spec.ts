// TDD: parsePointsAwardExcel
// Converts horizontal Excel layout → flat PointsAwardRow[]
//
// Expected Excel format:
//   Outlet ID | Month | <param1> | <param2> | ... | Total
//   OUT-001   | Jul-26 | 150 | 100 | 0 | 250
//
// Rules:
//   - Parameter columns = everything between "Month" and "Total" (case-insensitive)
//   - Skip columns where value is 0, blank, or non-numeric
//   - outletCode = trimmed value of "Outlet ID" column
//   - month normalised to "YYYY-MM" string (handles Excel date serial, "Jul-26", "2026-07", "07/2026")
//   - Rows where Outlet ID is blank are skipped (summary / empty rows)
//   - Throws if required header columns are missing

import * as XLSX from 'xlsx';
import { parsePointsAwardExcel } from './excel-parser';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeBuffer(
  rows: Array<Record<string, any>>,
  headers?: string[],
): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

function makeBufferFromAoA(data: any[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('parsePointsAwardExcel', () => {

  it('parses a single row with two parameters into two PointsAwardRows', () => {
    const buf = makeBufferFromAoA([
      ['Outlet ID', 'Month', 'Soybean Oil', 'Sunflower Oil', 'Total'],
      ['OUT-001',   '2026-07', 150,          100,             250  ],
    ]);

    const rows = parsePointsAwardExcel(buf);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ outletCode: 'OUT-001', month: '2026-07', parameterName: 'Soybean Oil',   points: 150 });
    expect(rows[1]).toEqual({ outletCode: 'OUT-001', month: '2026-07', parameterName: 'Sunflower Oil', points: 100 });
  });

  it('skips parameter columns where value is 0', () => {
    const buf = makeBufferFromAoA([
      ['Outlet ID', 'Month',   'Soybean Oil', 'Sunflower Oil', 'Total'],
      ['OUT-001',   '2026-07',  0,             100,             100  ],
    ]);

    const rows = parsePointsAwardExcel(buf);

    expect(rows).toHaveLength(1);
    expect(rows[0].parameterName).toBe('Sunflower Oil');
  });

  it('skips parameter columns where value is blank / undefined', () => {
    const buf = makeBufferFromAoA([
      ['Outlet ID', 'Month',   'Soybean Oil', 'Sunflower Oil', 'Total'],
      ['OUT-001',   '2026-07',  '',            200,             200  ],
    ]);

    const rows = parsePointsAwardExcel(buf);

    expect(rows).toHaveLength(1);
    expect(rows[0].points).toBe(200);
  });

  it('skips rows where Outlet ID is blank (summary rows)', () => {
    const buf = makeBufferFromAoA([
      ['Outlet ID', 'Month',   'Soybean Oil', 'Total'],
      ['OUT-001',   '2026-07',  150,           150   ],
      ['',          '2026-07',  300,           300   ],  // blank outlet = summary
    ]);

    const rows = parsePointsAwardExcel(buf);

    expect(rows).toHaveLength(1);
    expect(rows[0].outletCode).toBe('OUT-001');
  });

  it('handles multiple data rows correctly', () => {
    const buf = makeBufferFromAoA([
      ['Outlet ID', 'Month',   'Soybean Oil', 'Sunflower Oil', 'Total'],
      ['OUT-001',   '2026-07',  150,           100,             250  ],
      ['OUT-002',   '2026-07',  200,           0,               200  ],
    ]);

    const rows = parsePointsAwardExcel(buf);

    // OUT-001: 2 params; OUT-002: 1 param (Sunflower skipped — 0)
    expect(rows).toHaveLength(3);
    expect(rows.filter(r => r.outletCode === 'OUT-001')).toHaveLength(2);
    expect(rows.filter(r => r.outletCode === 'OUT-002')).toHaveLength(1);
  });

  it('trims whitespace from outletCode', () => {
    const buf = makeBufferFromAoA([
      ['Outlet ID', 'Month',   'Soybean Oil', 'Total'],
      ['  OUT-001 ','2026-07',  150,           150  ],
    ]);

    const rows = parsePointsAwardExcel(buf);

    expect(rows[0].outletCode).toBe('OUT-001');
  });

  it('normalises "Jul-26" month string to "2026-07"', () => {
    const buf = makeBufferFromAoA([
      ['Outlet ID', 'Month',  'Soybean Oil', 'Total'],
      ['OUT-001',   'Jul-26',  150,           150  ],
    ]);

    const rows = parsePointsAwardExcel(buf);

    expect(rows[0].month).toBe('2026-07');
  });

  it('keeps "2026-07" month string as-is', () => {
    const buf = makeBufferFromAoA([
      ['Outlet ID', 'Month',   'Soybean Oil', 'Total'],
      ['OUT-001',   '2026-07',  150,           150  ],
    ]);

    const rows = parsePointsAwardExcel(buf);

    expect(rows[0].month).toBe('2026-07');
  });

  it('is case-insensitive for header names (OUTLET ID, MONTH, TOTAL)', () => {
    const buf = makeBufferFromAoA([
      ['OUTLET ID', 'MONTH',   'Soybean Oil', 'TOTAL'],
      ['OUT-001',   '2026-07',  150,           150  ],
    ]);

    const rows = parsePointsAwardExcel(buf);

    expect(rows).toHaveLength(1);
    expect(rows[0].outletCode).toBe('OUT-001');
  });

  it('throws if "Outlet ID" column is missing', () => {
    const buf = makeBufferFromAoA([
      ['Month',   'Soybean Oil', 'Total'],
      ['2026-07',  150,           150  ],
    ]);

    expect(() => parsePointsAwardExcel(buf)).toThrow(/outlet/i);
  });

  it('throws if "Month" column is missing', () => {
    const buf = makeBufferFromAoA([
      ['Outlet ID', 'Soybean Oil', 'Total'],
      ['OUT-001',    150,           150   ],
    ]);

    expect(() => parsePointsAwardExcel(buf)).toThrow(/month/i);
  });

  it('returns empty array when there are no data rows', () => {
    const buf = makeBufferFromAoA([
      ['Outlet ID', 'Month', 'Soybean Oil', 'Total'],
    ]);

    const rows = parsePointsAwardExcel(buf);

    expect(rows).toHaveLength(0);
  });
});
