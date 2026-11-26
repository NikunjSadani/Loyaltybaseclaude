'use client';

/**
 * Target upload refused because focus product names contain NUMBERS (owner 2026-11-26) — e.g. "1011.2697 & ADHO500",
 * a ₹ figure typed into the name. The API's 400 carries `details` { code: 'NUMERIC_FOCUS_NAMES', total, columns, items }
 * with EVERY bad name; this lists the first few and offers the full list as a CSV so nothing is hidden.
 */
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downloadBlob } from '@/lib/download';

export interface NumericFocusNameItem {
  outletCode: string;
  month: string;
  column: string;
  value: string;
  name: string;
}

export interface NumericFocusNamesDetails {
  code: 'NUMERIC_FOCUS_NAMES';
  total: number;
  columns: string[];
  items: NumericFocusNameItem[];
}

/** The refusal's details when (and only when) it is the numeric-focus-names refusal. */
export function numericFocusNamesOf(details: unknown): NumericFocusNamesDetails | null {
  const d = details as Partial<NumericFocusNamesDetails> | null | undefined;
  if (!d || d.code !== 'NUMERIC_FOCUS_NAMES' || !Array.isArray(d.items)) return null;
  return { code: 'NUMERIC_FOCUS_NAMES', total: d.total ?? d.items.length, columns: d.columns ?? [], items: d.items };
}

/** Rows shown on screen; the rest are in the CSV. */
export const NUMERIC_FOCUS_SHOWN = 20;

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function numericFocusNamesCsv(items: readonly NumericFocusNameItem[]): string {
  const lines = [['Outlet ID', 'Month', 'Column', 'Number found', 'Name as written']];
  for (const i of items) lines.push([i.outletCode, i.month, i.column, i.value, i.name]);
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function NumericFocusNamesList({ details }: { details: NumericFocusNamesDetails }) {
  const shown = details.items.slice(0, NUMERIC_FOCUS_SHOWN);
  const rest = details.items.length - shown.length;
  return (
    <div className="rounded-xl border border-red-200 bg-white px-3 py-2.5 text-sm space-y-2" data-testid="numeric-focus-names">
      <p className="font-medium text-red-800">
        {details.total.toLocaleString('en-IN')} focus brand {details.total === 1 ? 'name has' : 'names have'} a number
        where a product should be{details.columns.length > 0 ? ` (${details.columns.map((c) => `“${c}”`).join(', ')})` : ''}:
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs w-full">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1 pr-3 font-medium">Outlet ID</th>
              <th className="py-1 pr-3 font-medium">Month</th>
              <th className="py-1 pr-3 font-medium">Column</th>
              <th className="py-1 pr-3 font-medium">Number found</th>
              <th className="py-1 font-medium">Name as written</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((i, n) => (
              <tr key={`${i.outletCode}-${i.month}-${i.column}-${i.value}-${n}`} className="border-t border-gray-100" data-testid="numeric-focus-name-row">
                <td className="py-1 pr-3 font-mono">{i.outletCode}</td>
                <td className="py-1 pr-3">{i.month}</td>
                <td className="py-1 pr-3">{i.column}</td>
                <td className="py-1 pr-3 font-semibold text-red-700">{i.value}</td>
                <td className="py-1 [overflow-wrap:anywhere]">{i.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {rest > 0 && (
          <span className="text-xs text-gray-600" data-testid="numeric-focus-names-more">
            …and {rest.toLocaleString('en-IN')} more (in the download).
          </span>
        )}
        <Button size="sm" variant="outline" data-testid="numeric-focus-names-download"
          onClick={() => downloadBlob(new Blob([numericFocusNamesCsv(details.items)], { type: 'text/csv;charset=utf-8' }), 'focus-names-with-numbers.csv')}>
          <Download className="w-3.5 h-3.5" /> Download the full list ({details.items.length.toLocaleString('en-IN')})
        </Button>
      </div>
    </div>
  );
}
