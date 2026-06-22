'use client';

import { Download } from 'lucide-react';
import { buildErrorReportBuffer, downloadErrorReport } from '@/lib/error-report';

interface DownloadErrorReportButtonProps {
  /** Source column headers, in order. */
  columns: string[];
  /** One record per input row. ALL rows are emitted (clean rows included). */
  rows: Record<string, unknown>[];
  /** Resolver returning the error messages for a given row. */
  errorsByRow: (row: Record<string, unknown>, idx: number) => string[];
  /** Download filename (e.g. `outlet-upload-errors.xlsx`). */
  filename: string;
  /** Sheet name override (default 'Errors'). */
  sheetName?: string;
  /** Errors column header override (default 'Errors'). */
  errorHeader?: string;
  className?: string;
}

/**
 * Small admin button that downloads a re-uploadable .xlsx error report
 * (one row per input row + an "Errors" column). Renders only when at least
 * one row has errors.
 */
export default function DownloadErrorReportButton({
  columns,
  rows,
  errorsByRow,
  filename,
  sheetName,
  errorHeader,
  className,
}: DownloadErrorReportButtonProps) {
  const hasErrors = rows.some((row, idx) => errorsByRow(row, idx).length > 0);
  if (!hasErrors) return null;

  const handleClick = () => {
    const buf = buildErrorReportBuffer(columns, rows, errorsByRow, {
      sheetName,
      errorHeader,
    });
    downloadErrorReport(buf, filename);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={
        className ??
        'flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-semibold rounded-lg hover:bg-red-700 transition-colors shrink-0'
      }
    >
      <Download className="w-4 h-4" /> Download Error Report
    </button>
  );
}
