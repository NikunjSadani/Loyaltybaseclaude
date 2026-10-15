/// <reference types="vitest/globals" />
/**
 * TDD — Outlet Master Export
 *
 * Groups:
 *   A — OutletMasterRow type shape (source-read)
 *   B — DEMO_OUTLET_MASTER_ROWS data quality
 *   C — generateOutletMasterExcel returns valid bytes
 *   D — Column structure & counts
 *   E — Signature column exists and is populated
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve }                  from 'path';
import * as XLSX                    from 'xlsx';

const src = (rel: string) =>
  readFileSync(resolve(__dirname, '../../..', rel), 'utf-8');
const exists = (rel: string) =>
  existsSync(resolve(__dirname, '../../..', rel));

// ─── A: Type shape (source-read) ─────────────────────────────────────────────

describe('A — OutletMasterRow type shape', () => {
  it('A1: OutletMasterRow is exported from src/types/index.ts', () => {
    const code = src('src/types/index.ts');
    expect(code).toMatch(/export interface OutletMasterRow/);
  });

  it('A2: includes accountHolderName field', () => {
    const code = src('src/types/index.ts');
    expect(code).toMatch(/accountHolderName\?:\s*string/);
  });

  it('A3: includes docSignature field for signature URL', () => {
    const code = src('src/types/index.ts');
    expect(code).toMatch(/docSignature\?:\s*string/);
  });

  it('A4: includes deactivatedAt and reactivatedAt lifecycle fields', () => {
    const code = src('src/types/index.ts');
    expect(code).toMatch(/deactivatedAt\?:\s*string/);
    expect(code).toMatch(/reactivatedAt\?:\s*string/);
  });

  it('A5: includes all 6 hierarchy levels (L1–L6)', () => {
    const code = src('src/types/index.ts');
    for (let i = 1; i <= 6; i++) {
      expect(code).toMatch(new RegExp(`hierarchyL${i}Id`));
      expect(code).toMatch(new RegExp(`hierarchyL${i}Name`));
    }
  });
});

// ─── B: Demo data quality ─────────────────────────────────────────────────────

describe('B — DEMO_OUTLET_MASTER_ROWS', () => {
  let rows: import('@/types').OutletMasterRow[];

  beforeAll(async () => {
    const mod = await import('../outlet-master-export');
    rows = mod.DEMO_OUTLET_MASTER_ROWS;
  });

  it('B1: has exactly 10 demo rows', () => {
    expect(rows).toHaveLength(10);
  });

  it('B2: every row has a non-empty outletId', () => {
    rows.forEach(r => expect(r.outletId).toBeTruthy());
  });

  it('B3: every row has a non-empty outletName', () => {
    rows.forEach(r => expect(r.outletName).toBeTruthy());
  });

  it('B4: rows include at least one row with a docSignature value', () => {
    const hasSignature = rows.some(r => !!r.docSignature);
    expect(hasSignature).toBe(true);
  });

  it('B5: rows include at least one approved KYC row with accountHolderName', () => {
    const hasApproved = rows.some(r => r.kycStatus === 'APPROVED' && !!r.accountHolderName);
    expect(hasApproved).toBe(true);
  });

  it('B6: rows include at least one deactivated outlet (deactivatedAt set)', () => {
    const hasDeactivated = rows.some(r => !!r.deactivatedAt);
    expect(hasDeactivated).toBe(true);
  });

  it('B7: rows include multiple outlet types', () => {
    const types = new Set(rows.map(r => r.outletType));
    expect(types.size).toBeGreaterThan(1);
  });
});

// ─── C: Excel generation ─────────────────────────────────────────────────────

describe('C — generateOutletMasterExcel', () => {
  let generateFn: typeof import('../outlet-master-export').generateOutletMasterExcel;
  let demoRows:   typeof import('../outlet-master-export').DEMO_OUTLET_MASTER_ROWS;

  beforeAll(async () => {
    const mod = await import('../outlet-master-export');
    generateFn = mod.generateOutletMasterExcel;
    demoRows   = mod.DEMO_OUTLET_MASTER_ROWS;
  });

  it('C1: lib file exists', () => {
    expect(exists('src/lib/outlet-master-export.ts')).toBe(true);
  });

  it('C2: generateOutletMasterExcel returns a Uint8Array', () => {
    const result = generateFn(demoRows);
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it('C3: returned buffer is non-empty (>100 bytes)', () => {
    const result = generateFn(demoRows);
    expect(result.length).toBeGreaterThan(100);
  });

  it('C4: works with an empty rows array', () => {
    const result = generateFn([]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── D: Column structure ─────────────────────────────────────────────────────

describe('D — Column structure', () => {
  it('D1: OUTLET_MASTER_COLUMN_COUNT is at least 60', async () => {
    const { OUTLET_MASTER_COLUMN_COUNT } = await import('../outlet-master-export');
    expect(OUTLET_MASTER_COLUMN_COUNT).toBeGreaterThanOrEqual(60);
  });

  it('D2: source includes all 9 section labels', () => {
    const code = src('src/lib/outlet-master-export.ts');
    const sections = [
      'A: Identity',
      'B: Contact/Address',
      'C: Program/Distribution',
      'D: Sales Hierarchy',
      'E: Enrollment',
      'F: KYC/Approval',
      'G: KYC Documents',
      'H: Banking',
      'I: Lifecycle',
    ];
    sections.forEach(s => expect(code).toContain(s));
  });

  it('D3: source references Account Holder Name column', () => {
    const code = src('src/lib/outlet-master-export.ts');
    expect(code).toMatch(/Account Holder Name/);
  });

  it('D4: the Program Category column label is renamed to "Sub-Program"', () => {
    const code = src('src/lib/outlet-master-export.ts');
    expect(code).toContain("label: 'Sub-Program'");
    // The old label is gone (the `programCategory` FIELD/key is intentionally unchanged).
    expect(code).not.toContain("'Program Category'");
  });
});

// ─── F: Geo columns (tenant-gated via geoEnabled) ────────────────────────────

describe('F — Latitude/Longitude geo columns', () => {
  let generateFn: typeof import('../outlet-master-export').generateOutletMasterExcel;
  let demoRows:   typeof import('../outlet-master-export').DEMO_OUTLET_MASTER_ROWS;

  beforeAll(async () => {
    const mod = await import('../outlet-master-export');
    generateFn = mod.generateOutletMasterExcel;
    demoRows   = mod.DEMO_OUTLET_MASTER_ROWS;
  });

  /** Read back the header (label) row — wsData is [sectionRow, headerRow, ...dataRows]. */
  const labelRow = (bytes: Uint8Array): string[] => {
    const wb  = XLSX.read(bytes, { type: 'array' });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    return (aoa[1] as string[]) ?? [];
  };

  it('F1: default export (geoEnabled off) omits Latitude/Longitude', () => {
    const labels = labelRow(generateFn(demoRows));
    expect(labels).not.toContain('Latitude');
    expect(labels).not.toContain('Longitude');
  });

  it('F2: geoEnabled export includes Latitude/Longitude columns', () => {
    const labels = labelRow(generateFn(demoRows, true));
    expect(labels).toContain('Latitude');
    expect(labels).toContain('Longitude');
  });

  it('F3: OUTLET_MASTER_COLUMN_COUNT (base) is unchanged by the geo feature', async () => {
    const { OUTLET_MASTER_COLUMN_COUNT } = await import('../outlet-master-export');
    const baseLen = labelRow(generateFn(demoRows)).length;
    expect(baseLen).toBe(OUTLET_MASTER_COLUMN_COUNT);
    // Geo export is exactly two columns wider.
    expect(labelRow(generateFn(demoRows, true)).length).toBe(baseLen + 2);
  });

  it('F4: geo export maps OutletMasterRow.latitude/longitude into the cells', () => {
    const row = { ...demoRows[0], latitude: '19.0760', longitude: '72.8777' };
    const wb  = XLSX.read(generateFn([row], true), { type: 'array' });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: '' });
    const labels = aoa[1] as string[];
    const data   = aoa[2] as string[];
    expect(data[labels.indexOf('Latitude')]).toBe('19.0760');
    expect(data[labels.indexOf('Longitude')]).toBe('72.8777');
  });
});

// ─── E: Signature ────────────────────────────────────────────────────────────

describe('E — Signature column', () => {
  it('E1: COLUMNS array includes a "Signature" entry', () => {
    const code = src('src/lib/outlet-master-export.ts');
    expect(code).toMatch(/docSignature/);
    expect(code).toMatch(/Signature/);
  });

  // E2/E3 (platform app/api/admin/reports/outlet-master route) retired with D2 (#31).
});
