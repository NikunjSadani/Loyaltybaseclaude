/**
 * Credits & Payouts — Excel Template Generator (pure)
 *
 * Generates the pre-populated upload template for the Credits & Payouts module.
 * Outlets are passed in by the caller (from /api/admin/credits/eligible-outlets).
 *
 * Column layout (one row per eligible outlet):
 *   Outlet ID | Outlet Name | [Field1] | [Field2] | ... | [FieldN]
 *   | [Field1 Narration] | [Field2 Narration] | ... | [FieldN Narration]
 *
 * Rules:
 *  - Deactivated fields are NOT included
 *  - Narration columns appear AFTER all value columns
 *  - Columns ordered by field.order (creation order, never changes)
 *
 * Sheet name: "Credits & Payouts"
 * Title row: "Credits & Payouts Data — {Month Label}"
 */

import * as XLSX from 'xlsx';
import type { CreditField } from '@/types';

export interface TemplateOutlet {
  id:       string;
  name:     string;
  type:     string;
  phone?:   string;
}

// ─── Month label helper ───────────────────────────────────────────────────────

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}

// ─── Template generator ───────────────────────────────────────────────────────

/**
 * Generates the Excel template buffer.
 *
 * @param fields  Active CreditField[] in creation order.
 * @param month   'YYYY-MM' — shown in the title row.
 * @param outlets Eligible outlets (from /api/admin/credits/eligible-outlets).
 */
export function generateCreditTemplate(
  fields:  CreditField[],
  month:   string,
  outlets: TemplateOutlet[],
): ArrayBuffer {
  const activeFields = fields.filter((f) => f.isActive);

  // Build header row: fixed cols + value cols + narration cols
  const valueHeaders     = activeFields.map((f) => f.name);
  const narrationHeaders = activeFields.map((f) => `${f.name} Narration`);
  const headers          = ['Outlet ID', 'Outlet Name', ...valueHeaders, ...narrationHeaders];

  // Build data rows (values blank, ready for admin to fill)
  const dataRows = outlets.map((o) => {
    const row: (string | number)[] = [o.id, o.name];
    for (let i = 0; i < activeFields.length; i++) row.push('');
    for (let i = 0; i < activeFields.length; i++) row.push('');
    return row;
  });

  // Build worksheet
  const wsData: (string | number)[][] = [
    [`Credits & Payouts Data — ${monthLabel(month)}`],
    headers,
    ...dataRows,
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);

  ws['!freeze'] = { xSplit: 0, ySplit: 2 };
  ws['!cols'] = [
    { wch: 14 },
    { wch: 28 },
    ...activeFields.map(() => ({ wch: 16 })),
    ...activeFields.map(() => ({ wch: 24 })),
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Credits & Payouts');

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
