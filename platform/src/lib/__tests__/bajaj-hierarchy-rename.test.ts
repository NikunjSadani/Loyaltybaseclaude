/// <reference types="vitest/globals" />
/**
 * Bajaj hierarchy nomenclature rename — Stream FE-CORE.
 *
 * Internal role codes stay XSR/SO/ASM/RSM/ZNM/NSM; only the display LABELS and column
 * HEADERS are Bajaj-specific. Deoleo (and every other tenant) must be byte-identical.
 *
 * Canonical mapping (docs/plans/BAJAJ-HIERARCHY-RENAME.md):
 *   code  label  idHeader   Name col   Phone col (FE)
 *   XSR → ISR    ISR Code   ISR Name   ISR Phone
 *   SO  → SO     SO HQ      SO Name    SO Phone
 *   ASM → ASM    ASM HQ     ASM Name   ASM Phone
 *   RSM → SM     SM HQ      SM Name    SM Phone
 *   ZNM → ZH     ZH HQ      ZH Name    ZH Phone
 *   NSM → NSM    NSM HQ     NSM Name   NSM Phone
 */

import { describe, it, expect } from 'vitest';
import {
  BAJAJ_HIERARCHY,
  DEOLEO_HIERARCHY,
  hierarchyConfigForTenant,
  getHierarchyChainHeaders,
  validateHierarchyChainHeaders,
  parseHierarchyChainRows,
  resolveRole,
  leafIdHeaderForTenant,
  displayLabelForTenant,
} from '../employee-hierarchy';

const bajaj = BAJAJ_HIERARCHY;

// Canonical Bajaj 18-column header set, leaf→root.
const BAJAJ_HEADERS = [
  'ISR Code', 'ISR Name', 'ISR Phone',
  'SO HQ',    'SO Name',  'SO Phone',
  'ASM HQ',   'ASM Name', 'ASM Phone',
  'SM HQ',    'SM Name',  'SM Phone',
  'ZH HQ',    'ZH Name',  'ZH Phone',
  'NSM HQ',   'NSM Name', 'NSM Phone',
];

// ─── Config resolver ────────────────────────────────────────────────────────

describe('hierarchyConfigForTenant', () => {
  it('returns BAJAJ_HIERARCHY for the bajaj slug (case-insensitive)', () => {
    expect(hierarchyConfigForTenant('bajaj')).toBe(BAJAJ_HIERARCHY);
    expect(hierarchyConfigForTenant('BAJAJ')).toBe(BAJAJ_HIERARCHY);
    expect(hierarchyConfigForTenant(' bajaj ')).toBe(BAJAJ_HIERARCHY);
  });

  it('returns DEOLEO_HIERARCHY for any other slug (deoleo, unknown, empty)', () => {
    expect(hierarchyConfigForTenant('deoleo')).toBe(DEOLEO_HIERARCHY);
    expect(hierarchyConfigForTenant('kwality')).toBe(DEOLEO_HIERARCHY);
    expect(hierarchyConfigForTenant('')).toBe(DEOLEO_HIERARCHY);
  });

  it('keeps internal role codes UNCHANGED for Bajaj (codes never renamed)', () => {
    expect(bajaj.map(l => l.roleCode)).toEqual(['XSR', 'SO', 'ASM', 'RSM', 'ZNM', 'NSM']);
    expect(bajaj.map(l => l.displayLabel)).toEqual(['ISR', 'SO', 'ASM', 'SM', 'ZH', 'NSM']);
    expect(bajaj.every(l => l.tenantId === 'bajaj')).toBe(true);
  });
});

// ─── Chain headers ──────────────────────────────────────────────────────────

describe('getHierarchyChainHeaders — tenant nomenclature', () => {
  it('Bajaj headers match the canonical mapping exactly', () => {
    expect(getHierarchyChainHeaders(bajaj)).toEqual(BAJAJ_HEADERS);
  });

  it('Deoleo headers are UNCHANGED (byte-identical)', () => {
    expect(getHierarchyChainHeaders(DEOLEO_HIERARCHY)).toEqual([
      'XSR ID', 'XSR Name', 'XSR Phone',
      'SO ID',  'SO Name',  'SO Phone',
      'ASM ID', 'ASM Name', 'ASM Phone',
      'RSM ID', 'RSM Name', 'RSM Phone',
      'ZNM ID', 'ZNM Name', 'ZNM Phone',
      'NSM ID', 'NSM Name', 'NSM Phone',
    ]);
  });
});

// ─── Header validation (new OR legacy accepted) ─────────────────────────────

describe('validateHierarchyChainHeaders — backward-compat', () => {
  it('accepts a file with the NEW Bajaj headers under Bajaj config', () => {
    expect(validateHierarchyChainHeaders(BAJAJ_HEADERS, bajaj)).toBeNull();
  });

  it('accepts a LEGACY (XSR…) header file under Bajaj config', () => {
    const legacy = getHierarchyChainHeaders(DEOLEO_HIERARCHY); // XSR ID / … / NSM Phone
    expect(validateHierarchyChainHeaders(legacy, bajaj)).toBeNull();
  });

  it('rejects a file missing a column (names the canonical Bajaj header)', () => {
    const err = validateHierarchyChainHeaders(['ISR Code', 'SO HQ'], bajaj);
    expect(err).toMatch(/missing/i);
    expect(err).toMatch(/ISR Name/);
  });

  it('Deoleo header validation is unchanged (legacy === new)', () => {
    expect(validateHierarchyChainHeaders(getHierarchyChainHeaders(DEOLEO_HIERARCHY), DEOLEO_HIERARCHY)).toBeNull();
  });
});

// ─── Parse — new headers ────────────────────────────────────────────────────

function makeBajajRow(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    'ISR Code': 'ISR-001', 'ISR Name': 'Anil Sharma',  'ISR Phone': '9900000001',
    'SO HQ':    'SO-001',  'SO Name':  'Rajesh Kumar',  'SO Phone':  '9900000002',
    'ASM HQ':   'ASM-001', 'ASM Name': 'Priya Mehta',   'ASM Phone': '9900000003',
    'SM HQ':    'SM-001',  'SM Name':  'Suresh Nair',   'SM Phone':  '9900000004',
    'ZH HQ':    'ZH-001',  'ZH Name':  'Vikram Singh',  'ZH Phone':  '9900000005',
    'NSM HQ':   'NSM-001', 'NSM Name': 'Anand Rao',     'NSM Phone': '9900000006',
    ...overrides,
  };
}

describe('parseHierarchyChainRows — Bajaj new headers', () => {
  it('parses a clean Bajaj file into 6 employee rows (one per level)', () => {
    const result = parseHierarchyChainRows([makeBajajRow()], bajaj);
    expect(result.hasErrors).toBe(false);
    expect(result.employeeRows).toHaveLength(6);
  });

  it('maps columns to the correct INTERNAL role codes (SM→RSM, ZH→ZNM, ISR→XSR)', () => {
    const result = parseHierarchyChainRows([makeBajajRow()], bajaj);
    const byId = Object.fromEntries(result.employeeRows.map(r => [r.employeeId, r.hierarchy]));
    expect(byId['ISR-001']).toBe('XSR');
    expect(byId['SM-001']).toBe('RSM');
    expect(byId['ZH-001']).toBe('ZNM');
    expect(byId['NSM-001']).toBe('NSM');
  });

  it('leaf (ISR) reports to the SO from the same row', () => {
    const result = parseHierarchyChainRows([makeBajajRow()], bajaj);
    const isr = result.employeeRows.find(r => r.hierarchy === 'XSR');
    expect(isr!.reportingManagerEmployeeId).toBe('SO-001');
  });

  it('a missing ID surfaces the Bajaj ID-header in the error message', () => {
    const result = parseHierarchyChainRows([makeBajajRow({ 'SM HQ': '' })], bajaj);
    expect(result.hasErrors).toBe(true);
    const err = result.chainErrors.find(e => e.type === 'MISSING_ID');
    expect(err!.message).toMatch(/SM HQ is missing/);
  });
});

// ─── Parse — LEGACY headers under Bajaj config (backward-compat) ─────────────

function makeLegacyRow(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    'XSR ID': 'XSR-001', 'XSR Name': 'Anil Sharma',   'XSR Phone': '9900000001',
    'SO ID':  'SO-001',  'SO Name':  'Rajesh Kumar',  'SO Phone':  '9900000002',
    'ASM ID': 'ASM-001', 'ASM Name': 'Priya Mehta',   'ASM Phone': '9900000003',
    'RSM ID': 'RSM-001', 'RSM Name': 'Suresh Nair',   'RSM Phone': '9900000004',
    'ZNM ID': 'ZNM-001', 'ZNM Name': 'Vikram Singh',  'ZNM Phone': '9900000005',
    'NSM ID': 'NSM-001', 'NSM Name': 'Anand Rao',     'NSM Phone': '9900000006',
    ...overrides,
  };
}

describe('parseHierarchyChainRows — LEGACY file under Bajaj config', () => {
  it('still parses a pre-rename (XSR…) file to 6 employee rows', () => {
    const result = parseHierarchyChainRows([makeLegacyRow()], bajaj);
    expect(result.hasErrors).toBe(false);
    expect(result.employeeRows).toHaveLength(6);
  });

  it('resolves the same internal codes from the legacy columns', () => {
    const result = parseHierarchyChainRows([makeLegacyRow()], bajaj);
    const codes = result.employeeRows.map(r => r.hierarchy).sort();
    expect(codes).toEqual(['ASM', 'NSM', 'RSM', 'SO', 'XSR', 'ZNM']);
  });
});

// ─── resolveRole — label aliases ────────────────────────────────────────────

describe('resolveRole — Bajaj display-label aliases', () => {
  it('accepts the Bajaj labels ISR/SM/ZH as aliases for XSR/RSM/ZNM', () => {
    expect(resolveRole('ISR', bajaj)?.roleCode).toBe('XSR');
    expect(resolveRole('SM', bajaj)?.roleCode).toBe('RSM');
    expect(resolveRole('ZH', bajaj)?.roleCode).toBe('ZNM');
  });

  it('still accepts the internal codes under Bajaj config', () => {
    expect(resolveRole('XSR', bajaj)?.roleCode).toBe('XSR');
    expect(resolveRole('rsm', bajaj)?.roleCode).toBe('RSM');
    expect(resolveRole('NSM', bajaj)?.roleCode).toBe('NSM');
  });

  it('Deoleo does NOT accept the Bajaj labels (byte-identical — code-only)', () => {
    expect(resolveRole('ISR', DEOLEO_HIERARCHY)).toBeNull();
    expect(resolveRole('SM', DEOLEO_HIERARCHY)).toBeNull();
    expect(resolveRole('XSR', DEOLEO_HIERARCHY)?.roleCode).toBe('XSR');
  });
});

// ─── Exported helpers for sibling streams ───────────────────────────────────

describe('leafIdHeaderForTenant / displayLabelForTenant', () => {
  it('leafIdHeaderForTenant: "ISR Code" for bajaj, "XSR ID" for deoleo', () => {
    expect(leafIdHeaderForTenant('bajaj')).toBe('ISR Code');
    expect(leafIdHeaderForTenant('deoleo')).toBe('XSR ID');
    expect(leafIdHeaderForTenant('unknown')).toBe('XSR ID');
  });

  it('displayLabelForTenant: maps internal codes to Bajaj labels, falls back to code', () => {
    expect(displayLabelForTenant('bajaj', 'XSR')).toBe('ISR');
    expect(displayLabelForTenant('bajaj', 'RSM')).toBe('SM');
    expect(displayLabelForTenant('bajaj', 'ZNM')).toBe('ZH');
    expect(displayLabelForTenant('bajaj', 'NSM')).toBe('NSM');
    expect(displayLabelForTenant('bajaj', 'UNKNOWN')).toBe('UNKNOWN'); // fallback
  });

  it('displayLabelForTenant: Deoleo returns the code unchanged', () => {
    expect(displayLabelForTenant('deoleo', 'XSR')).toBe('XSR');
    expect(displayLabelForTenant('deoleo', 'RSM')).toBe('RSM');
  });
});

// ─── Round-trip: Bajaj headers + parse ──────────────────────────────────────

describe('Bajaj round-trip', () => {
  it('two ISRs sharing upper managers dedupe to 7 employee rows', () => {
    const row1 = makeBajajRow();
    const row2 = makeBajajRow({ 'ISR Code': 'ISR-002', 'ISR Name': 'Deepa Nair', 'ISR Phone': '9900000011' });
    const result = parseHierarchyChainRows([row1, row2], bajaj);
    expect(result.hasErrors).toBe(false);
    expect(result.employeeRows).toHaveLength(7);
  });
});
