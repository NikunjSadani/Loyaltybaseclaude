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
});

// ─── E: Signature ────────────────────────────────────────────────────────────

describe('E — Signature column', () => {
  it('E1: COLUMNS array includes a "Signature" entry', () => {
    const code = src('src/lib/outlet-master-export.ts');
    expect(code).toMatch(/docSignature/);
    expect(code).toMatch(/Signature/);
  });

  it('E2: API route file exists', () => {
    expect(exists('src/app/api/admin/reports/outlet-master/route.ts')).toBe(true);
  });

  it('E3: API route uses generateOutletMasterExcel', () => {
    const code = src('src/app/api/admin/reports/outlet-master/route.ts');
    expect(code).toMatch(/generateOutletMasterExcel/);
  });
});
