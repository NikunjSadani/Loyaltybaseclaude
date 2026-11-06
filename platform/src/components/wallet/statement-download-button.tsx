'use client';

/**
 * Shared "Download" button → Excel / PDF menu for the wallet statement (owner decision D7). Used by
 * the partner wallet and the sales outlet ledger. `loadDoc` fetches the FULL statement for the
 * selected range (D4) and builds the shared StatementDoc; the file is rendered in the browser (D6)
 * by the renderer modules, which are imported on demand to keep them out of the page bundle.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { downloadBlob } from '@/lib/download';
import type { StatementDoc } from '@/lib/wallet-statement/statement-model';

type Format = 'xlsx' | 'pdf';

export interface StatementDownloadButtonProps {
  disabled: boolean;
  loadDoc: () => Promise<StatementDoc>;
  /** File name without extension, e.g. `wallet-statement-OUT1-2026-04_2026-06`. */
  fileBase: string;
}

export function StatementDownloadButton({ disabled, loadDoc, fileBase }: StatementDownloadButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const busyRef = useRef(false); // synchronous guard against a double pick before re-render
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const pick = async (format: Format) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setOpen(false);
    setBusy(true);
    setError(false);
    try {
      const doc = await loadDoc();
      const blob =
        format === 'xlsx'
          ? (await import('@/lib/wallet-statement/statement-xlsx')).statementToXlsxBlob(doc)
          : await (await import('@/lib/wallet-statement/statement-pdf')).statementToPdfBlob(doc);
      downloadBlob(blob, `${fileBase}.${format}`);
    } catch {
      setError(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const isDisabled = disabled || busy;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="statement-download-btn"
        onClick={() => { if (!isDisabled) setOpen((o) => !o); }}
        disabled={isDisabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Download statement"
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold border border-gray-200 bg-white text-gray-600 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)] transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-200 disabled:hover:text-gray-600"
      >
        {busy ? <Spinner size="sm" /> : <Download className="h-3.5 w-3.5" />}
        Download
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 mt-2 z-20 w-36 bg-white rounded-xl border border-gray-100 shadow-xl py-1"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => void pick('xlsx')}
            className="w-full text-left px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Excel (.xlsx)
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void pick('pdf')}
            className="w-full text-left px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            PDF
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="absolute top-full right-0 mt-1 whitespace-nowrap text-[10px] text-red-500">
          Couldn&apos;t download. Try again.
        </p>
      )}
    </div>
  );
}

export default StatementDownloadButton;
