/// <reference types="vitest/globals" />
/**
 * AF-5 — Spreadsheet formula-injection guard (client-side xlsx export).
 *
 * Groups:
 *   A — cellSafe escapes formula-leading characters, leaves benign strings
 *   B — aoaToSheetSafe / jsonToSheetSafe sanitise string cells, pass non-strings
 *   C — round-trip through a real export builder: crafted value comes back
 *       apostrophe-prefixed (proves the downloaded file is not an injection sink)
 */

import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { cellSafe, aoaToSheetSafe, jsonToSheetSafe } from '@/lib/xlsx-safe';
import { generateOutletMasterExcel } from '@/lib/outlet-master-export';
import type { OutletMasterRow } from '@/types';

// ─── A: cellSafe ──────────────────────────────────────────────────────────────

describe('A — cellSafe', () => {
  it('A1: escapes a leading "=" (formula)', () => {
    expect(cellSafe('=cmd()')).toBe("'=cmd()");
  });

  it('A2: escapes a leading "@"', () => {
    expect(cellSafe('@x')).toBe("'@x");
  });

  it('A3: escapes a leading "+"', () => {
    expect(cellSafe('+1')).toBe("'+1");
  });

  it('A4: escapes a leading "-"', () => {
    expect(cellSafe('-1')).toBe("'-1");
  });

  it('A5: escapes a leading tab and carriage return', () => {
    expect(cellSafe('\tx')).toBe("'\tx");
    expect(cellSafe('\rx')).toBe("'\rx");
  });

  it('A6: leaves benign strings untouched', () => {
    expect(cellSafe('Verma Traders')).toBe('Verma Traders');
    expect(cellSafe('OUT-2026-001')).toBe('OUT-2026-001');
    expect(cellSafe('')).toBe('');
  });

  it('A7: is idempotent — an already-escaped value is not double-escaped', () => {
    expect(cellSafe(cellSafe('=evil'))).toBe("'=evil");
  });
});

// ─── B: sheet builders ──────────────────────────────────────────────────────

describe('B — aoaToSheetSafe / jsonToSheetSafe', () => {
  it('B1: aoaToSheetSafe escapes a formula-leading string cell', () => {
    const ws = aoaToSheetSafe([['=WEBSERVICE("http://evil")', 42]]);
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });
    expect(rows[0][0]).toBe("'=WEBSERVICE(\"http://evil\")");
    // non-string cells pass through unchanged
    expect(rows[0][1]).toBe(42);
  });

  it('B2: jsonToSheetSafe escapes a formula-leading value', () => {
    const ws = jsonToSheetSafe([{ Name: '@SUM(A1)', Amount: 100 }]);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
    expect(rows[0].Name).toBe("'@SUM(A1)");
    expect(rows[0].Amount).toBe(100);
  });
});

// ─── C: round-trip through a real export builder ────────────────────────────

describe('C — export builder round-trip', () => {
  it('C1: a crafted outlet name comes back apostrophe-prefixed', () => {
    const evil = '=HYPERLINK("http://evil","click")';
    const row = {
      outletId: 'OUT-EVIL',
      outletName: evil,
      kycStatus: 'APPROVED',
      isActive: true,
    } as unknown as OutletMasterRow;

    const bytes = generateOutletMasterExcel([row]);
    const wb = XLSX.read(bytes, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1 });

    // Flatten and confirm the dangerous value never appears un-escaped, and the
    // escaped form is present somewhere in the sheet.
    const flat = aoa.flat().map(String);
    expect(flat).not.toContain(evil);
    expect(flat).toContain(`'${evil}`);
  });
});
