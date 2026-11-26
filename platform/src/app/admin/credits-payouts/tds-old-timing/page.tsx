'use client';

/**
 * Owner's one-off check (Gifsy admin only, read-only): 194C TDS recovery rows raised under the OLD timing (at the
 * bank file) whose payee has payouts that were never paid that year — failed, cancelled or reversed.
 * GET /api/admin/credits/tds-recovery/old-timing-check. Nothing on this page changes anything.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAdminSession } from '@/lib/admin-session';
import { formatInrPaise } from '@/lib/money-format';
import { jsonToSheetSafe } from '@/lib/xlsx-safe';
import { downloadBlob } from '@/lib/download';

interface MoneyCount { count: number; paise: number }

export interface OldTimingRow {
  recoveryId: string;
  clientId: string;
  payee: string;
  fyLabel: string;
  tenantSharePaise: number;
  tdsInvoiceNumber: string | null;
  bankFileCode: string | null;
  recordedAt: string;
  payouts: Record<string, MoneyCount>;
  notPaid: MoneyCount;
}

const inr = formatInrPaise;

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function payoutsText(p: Record<string, MoneyCount> | null | undefined): string {
  const parts = Object.entries(p ?? {})
    .filter(([, m]) => m && m.count > 0)
    .map(([status, m]) => `${status}: ${m.count.toLocaleString('en-IN')} (${inr(m.paise)})`);
  return parts.length ? parts.join(' · ') : '—';
}

export default function TdsOldTimingCheckPage() {
  const session = useAdminSession();
  const isGifsyAdmin = session.role === 'GIFSY_ADMIN';
  const [rows, setRows] = useState<OldTimingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/credits/tds-recovery/old-timing-check');
      const json = await res.json().catch(() => null);
      if (req !== reqRef.current) return;
      if (!json?.success || !Array.isArray(json.data)) {
        setError(json?.error ?? `Request failed (HTTP ${res.status})`);
        return;
      }
      setRows(json.data as OldTimingRow[]);
    } catch (e) {
      if (req !== reqRef.current) return;
      setError(`Network error — ${String((e as Error)?.message ?? e)}`);
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isGifsyAdmin) void load();
  }, [isGifsyAdmin, load]);

  function download() {
    if (!rows || rows.length === 0) return;
    setDownloadErr(null);
    import('xlsx')
      .then((XLSX) => {
        const sheet = jsonToSheetSafe(rows.map((r) => ({
          'Client': r.clientId,
          'Payee': r.payee,
          'FY': r.fyLabel,
          'Tenant share (₹)': r.tenantSharePaise / 100,
          'TDS invoice': r.tdsInvoiceNumber ?? '',
          'Bank file': r.bankFileCode ?? '',
          'Recorded at': fmtDateTime(r.recordedAt),
          'Payouts by status': payoutsText(r.payouts),
          'Not paid (rows)': r.notPaid?.count ?? 0,
          'Not paid (₹)': (r.notPaid?.paise ?? 0) / 100,
          'Recovery ID': r.recoveryId,
        })));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, sheet, 'Old-timing TDS check');
        const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
        const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        downloadBlob(blob, 'tds-194c-old-timing-check.xlsx');
      })
      .catch((e) => setDownloadErr(`Download failed: ${String((e as Error)?.message ?? e)}`));
  }

  if (!isGifsyAdmin) {
    return (
      <div className="max-w-4xl mx-auto">
        <p role="alert" className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 text-sm text-gray-700">
          Gifsy admins only.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-gray-900">194C TDS raised at the bank file — check</h2>
          <p className="text-xs text-gray-500">
            TDS rows raised under the old timing (at the bank file) whose payee has payouts that were never paid that
            year — failed, cancelled or reversed. Read-only: nothing here changes anything.
          </p>
        </div>
        <button
          type="button"
          onClick={download}
          disabled={!rows || rows.length === 0}
          className="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          Download (.xlsx)
        </button>
      </div>

      {downloadErr && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{downloadErr}</p>}

      {error ? (
        <div role="alert" data-testid="tds-old-timing-error" className="flex items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700">
          <span>Couldn&apos;t load the check: {error}</span>
          <button type="button" onClick={() => void load()} className="px-2.5 py-1 rounded-lg border border-red-200 bg-white hover:bg-red-50">
            Retry
          </button>
        </div>
      ) : !rows ? (
        <p role="status" className="text-xs text-gray-500 animate-pulse">Loading…</p>
      ) : rows.length === 0 ? (
        <p data-testid="tds-old-timing-empty" className="rounded-xl bg-gray-50 border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
          Nothing to check
        </p>
      ) : (
        <div className={`overflow-x-auto border border-gray-200 rounded-xl bg-white ${loading ? 'opacity-60' : ''}`} aria-busy={loading || undefined}>
          <table className="w-full text-xs" data-testid="tds-old-timing-table">
            <thead className="bg-gray-50">
              <tr>
                {['Client', 'Payee', 'FY', 'Tenant share', 'TDS invoice', 'Bank file', 'Recorded', 'Payouts by status', 'Not paid'].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-semibold text-gray-600 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((r) => (
                <tr key={r.recoveryId} data-testid={`tds-old-timing-row-${r.recoveryId}`}>
                  <td className="px-3 py-2 text-gray-700">{r.clientId}</td>
                  <td className="px-3 py-2 text-gray-800">{r.payee}</td>
                  <td className="px-3 py-2 text-gray-700">{r.fyLabel}</td>
                  <td className="px-3 py-2 text-right text-gray-900 whitespace-nowrap">{inr(r.tenantSharePaise)}</td>
                  <td className="px-3 py-2 font-mono text-gray-700">{r.tdsInvoiceNumber ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-gray-700">{r.bankFileCode ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-700 whitespace-nowrap">{fmtDateTime(r.recordedAt)}</td>
                  <td className="px-3 py-2 text-gray-700">{payoutsText(r.payouts)}</td>
                  <td className="px-3 py-2 text-right text-amber-800 whitespace-nowrap">
                    {(r.notPaid?.count ?? 0).toLocaleString('en-IN')} · {inr(r.notPaid?.paise ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
