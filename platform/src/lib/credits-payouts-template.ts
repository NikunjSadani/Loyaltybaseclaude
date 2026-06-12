/**
 * Credits & Payouts — Excel Template Generator
 *
 * Generates the pre-populated upload template for the Credits & Payouts module.
 *
 * Column layout (one row per eligible outlet):
 *   Outlet ID | Outlet Name | [Field1] | [Field2] | ... | [FieldN]
 *   | [Field1 Narration] | [Field2 Narration] | ... | [FieldN Narration]
 *
 * Rules:
 *  - Deactivated fields are NOT included
 *  - Narration columns appear AFTER all value columns
 *  - Columns ordered by field.order (creation order, never changes)
 *  - Only active enrolled outlets (demo: all MOCK_OUTLETS)
 *
 * Sheet name: "Credits & Payouts"
 * Title row: "Credits & Payouts Data — {Month Label}"
 */

import * as XLSX from 'xlsx';
import type { CreditField } from '@/types';
import { MOCK_OUTLETS } from '@/lib/targets';

export interface TemplateOutlet {
  id:       string;
  name:     string;
  type:     string;   // outlet type key
  phone?:   string;
}

// ─── Month label helper ───────────────────────────────────────────────────────

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

// ─── Build eligible outlet list ───────────────────────────────────────────────

/**
 * Returns all demo outlets from MOCK_OUTLETS as a flat list.
 * In production this would query the DB for active, enrolled outlets
 * with verified bank details for the given tenant.
 */
export function getEligibleOutlets(): TemplateOutlet[] {
  const result: TemplateOutlet[] = [];
  for (const [type, outlets] of Object.entries(MOCK_OUTLETS)) {
    for (const o of outlets) {
      result.push({ id: o.id, name: o.name, type });
    }
  }
  return result;
}

// ─── Template generator ───────────────────────────────────────────────────────

/**
 * Generates the Excel template buffer.
 *
 * @param fields  Active CreditField[] in creation order.
 * @param month   'YYYY-MM' — shown in the title row.
 * @param outlets Optional override for eligible outlets (defaults to all MOCK_OUTLETS).
 */
export function generateCreditTemplate(
  fields:  CreditField[],
  month:   string,
  outlets: TemplateOutlet[] = getEligibleOutlets(),
): ArrayBuffer {
  const activeFields = fields.filter((f) => f.isActive);

  // Build header row: fixed cols + value cols + narration cols
  const valueHeaders     = activeFields.map((f) => f.name);
  const narrationHeaders = activeFields.map((f) => `${f.name} Narration`);
  const headers          = ['Outlet ID', 'Outlet Name', ...valueHeaders, ...narrationHeaders];

  // Build data rows (values blank, ready for admin to fill)
  const dataRows = outlets.map((o) => {
    const row: (string | number)[] = [o.id, o.name];
    // Value cells — blank (admin fills these in)
    for (let i = 0; i < activeFields.length; i++) row.push('');
    // Narration cells — blank
    for (let i = 0; i < activeFields.length; i++) row.push('');
    return row;
  });

  // Build worksheet
  const wsData: (string | number)[][] = [
    // Title row
    [`Credits & Payouts Data — ${monthLabel(month)}`],
    // Header row
    headers,
    // Data rows
    ...dataRows,
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Style: freeze top 2 rows, set column widths
  ws['!freeze'] = { xSplit: 0, ySplit: 2 };
  ws['!cols'] = [
    { wch: 14 },  // Outlet ID
    { wch: 28 },  // Outlet Name
    ...activeFields.map(() => ({ wch: 16 })),   // value cols
    ...activeFields.map(() => ({ wch: 24 })),   // narration cols
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Credits & Payouts');

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
