/// <reference types="vitest/globals" />
/**
 * gift-disbursal lib — query builder (tenant-scope drops clientId), totals, and the
 * xlsx generator (delivered-value basis + tenant column dropped in tenant scope).
 *
 * Run: npx vitest run src/lib/__tests__/gift-disbursal.test.ts
 */
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  buildDisbursalQuery,
  computeTotals,
  statusCount,
  rowVendorLabel,
  disbursalColumns,
  generateDisbursalExcel,
  disbursalFilename,
  type DisbursalReport,
} from '@/lib/gift-disbursal';

const REPORT: DisbursalReport = {
  rows: [
    {
      clientId: 'deoleo', clientName: 'Deoleo', vendorId: 'v1', vendorName: 'Acme',
      sourceType: 'VENDOR', orderCount: 10, deliveredCount: 7, deliveredValuePaise: 700000,
      statusBreakdown: { PLACED: 1, DISPATCHED: 2, DELIVERED: 7 },
    },
    {
      clientId: 'deoleo', clientName: 'Deoleo', vendorId: null, vendorName: null,
      sourceType: 'PLATFORM', orderCount: 4, deliveredCount: 3, deliveredValuePaise: 300000,
      statusBreakdown: { DELIVERED: 3, CANCELLED: 1 },
    },
  ],
};

describe('buildDisbursalQuery', () => {
  it('GIFSY scope keeps clientId', () => {
    const q = buildDisbursalQuery({ clientId: 'deoleo', vendorId: 'v1', from: '2026-01-01', to: '2026-02-01' }, 'GIFSY');
    expect(q).toContain('clientId=deoleo');
    expect(q).toContain('vendorId=v1');
    expect(q).toContain('from=2026-01-01');
    expect(q).toContain('to=2026-02-01');
  });
  it('TENANT scope DROPS clientId (never lets a tenant admin probe another tenant)', () => {
    const q = buildDisbursalQuery({ clientId: 'other', vendorId: 'v1' }, 'TENANT');
    expect(q).not.toContain('clientId=');
    expect(q).toContain('vendorId=v1');
  });
  it('returns empty string when nothing is set', () => {
    expect(buildDisbursalQuery({}, 'TENANT')).toBe('');
  });
});

describe('computeTotals', () => {
  it('prefers server totals when present', () => {
    const withTotals = { ...REPORT, totals: { orderCount: 99, deliveredCount: 9, deliveredValuePaise: 900 } };
    expect(computeTotals(withTotals).orderCount).toBe(99);
  });
  it('sums rows when totals are absent (delivered value = delivered-only sum)', () => {
    const t = computeTotals(REPORT);
    expect(t.orderCount).toBe(14);
    expect(t.deliveredCount).toBe(10);
    expect(t.deliveredValuePaise).toBe(1_000_000);
  });
});

describe('statusCount + rowVendorLabel', () => {
  it('missing status keys read as 0', () => {
    expect(statusCount(REPORT.rows[0], 'FAILED')).toBe(0);
    expect(statusCount(REPORT.rows[0], 'DISPATCHED')).toBe(2);
  });
  it('labels a platform (no-vendor) row as "Platform"', () => {
    expect(rowVendorLabel(REPORT.rows[0])).toBe('Acme');
    expect(rowVendorLabel(REPORT.rows[1])).toBe('Platform');
  });
});

describe('disbursalColumns', () => {
  it('drops the Tenant column in tenant scope', () => {
    expect(disbursalColumns('GIFSY')[0]).toBe('Tenant');
    expect(disbursalColumns('TENANT')).not.toContain('Tenant');
  });
});

describe('generateDisbursalExcel', () => {
  it('produces a readable workbook with a TOTAL footer and delivered-value in ₹', () => {
    const bytes = generateDisbursalExcel(REPORT, 'GIFSY');
    expect(bytes).toBeInstanceOf(Uint8Array);
    const wb = XLSX.read(bytes, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    // Header + 2 data rows + TOTAL footer.
    expect(rows.length).toBe(4);
    const last = rows[rows.length - 1];
    expect(last[0]).toBe('TOTAL');
    // Delivered value total (₹) = 10,000 in the last column.
    expect(Number(last[last.length - 1])).toBe(10000);
  });
});

describe('disbursalFilename', () => {
  it('is date-stamped relative to the given now', () => {
    expect(disbursalFilename(new Date('2026-08-22T00:00:00Z'))).toBe('gift-disbursal-2026-08-22.xlsx');
  });
});
