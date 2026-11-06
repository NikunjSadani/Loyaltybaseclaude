/**
 * Wallet statement → Excel (.xlsx) Blob, built in the browser with the existing SheetJS (D6).
 * Shared by the partner wallet and the sales outlet ledger. Every cell goes through
 * `aoaToSheetSafe` (formula-injection guard). Points / Balance / Amount are NUMBER cells so a
 * user can sum them; the Balance is the stored per-row balance from the backend (D3).
 */
import * as XLSX from 'xlsx';
import { aoaToSheetSafe } from '@/lib/xlsx-safe';
import { formatISTDate, formatISTDateTime } from '@/lib/ist-date';
import type { StatementDoc } from './statement-model';

export const XLSX_HEADER = ['Date', 'Description', 'Type', 'Points', 'Balance', 'Amount (₹)', 'UTR'];
export const EMPTY_STATEMENT_TEXT = 'No transactions in this period';

export function statementToXlsxBlob(doc: StatementDoc): Blob {
  const rows: unknown[][] = [
    [doc.title],
    ['Outlet', `${doc.outletName} (${doc.outletCode})`],
    ['Period', doc.periodLabel],
    ['Opening balance', doc.openingBalance],
    [],
    XLSX_HEADER,
  ];

  if (doc.lines.length === 0) {
    rows.push([EMPTY_STATEMENT_TEXT]);
  } else {
    for (const l of doc.lines) {
      rows.push(
        l.kind === 'points'
          ? [formatISTDate(l.date), l.description, l.type, l.points, l.balance, '', '']
          : [formatISTDate(l.date), l.description, l.type, '', '', l.amountInr, l.utr],
      );
    }
  }
  rows.push([], ['Closing balance', '', '', '', doc.closingBalance], ['Generated', formatISTDateTime(doc.generatedAt)]);

  const ws = aoaToSheetSafe(rows);
  ws['!cols'] = [{ wch: 16 }, { wch: 44 }, { wch: 18 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Wallet Statement');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
