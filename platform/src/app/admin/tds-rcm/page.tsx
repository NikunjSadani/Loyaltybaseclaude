'use client';

/**
 * /admin/tds-rcm — Unregistered-retailer / RCM source report (Wave 2 Stream E, design D6).
 *
 * GIFSY_ADMIN ONLY. Self-billed invoices raised to UNREGISTERED retailers carry NO GST on the
 * invoice face — instead TGSL (the recipient of the service) owes GST under REVERSE CHARGE (RCM),
 * computed OFF-PORTAL. This screen is the source list for that off-portal computation: every
 * unregistered-retailer invoice WITH its invoice number + taxable value.
 *
 * Role scope (enforced server-side; mirrored here):
 *   - GIFSY_ADMIN  — platform-wide, optional ?clientId= and ?period= operator filters.
 *   - anyone else  — not permitted: the page renders an access hint and NEVER fetches.
 *
 * Backend:
 *   GET /api/admin/tds-reports/unregistered[?clientId=&period=YYYY-MM]
 *       → { scope, note, count, totals:{ subtotal }, rows:[…] }
 *   GET /api/admin/tds-reports/unregistered/export[?clientId=&period=YYYY-MM]  → xlsx
 *
 * Money: paise arrives as { paise, inr }; rendered via formatINR (paise number) — exact, no
 * fabricated numbers on error.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  FileWarning,
  Download,
  XCircle,
  FileBarChart2,
  Info,
} from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';
import { authHeader } from '@/lib/api-client';
import { formatINR } from '@/lib/money';

// ─── Backend shapes ─────────────────────────────────────────────────────────────

interface Money {
  paise: string;
  inr: number;
}

interface UnregisteredRow {
  clientId: string;
  invoiceNumber: string;
  invoiceKind: string;
  partnerId: string;
  businessName: string | null;
  ownerName: string | null;
  panNumber: string | null;
  outletCode: string;
  period: string;
  invoiceDate: string;
  subtotal: Money;
  gst: Money;
  total: Money;
}

interface UnregisteredResponse {
  scope: { clientId: string | null; period: string | null };
  note: string;
  count: number;
  totals: { subtotal: Money };
  rows: UnregisteredRow[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

function money(m: Money): string {
  return formatINR(Number(m.paise));
}

/** Trigger a browser download of an xlsx blob from a backend endpoint. */
async function downloadXlsx(url: string, fallbackName: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: authHeader() });
    if (!res.ok) {
      try {
        const j = (await res.json()) as { error?: string; message?: string };
        return j.error ?? j.message ?? `HTTP ${res.status}`;
      } catch {
        return `HTTP ${res.status}`;
      }
    }
    const cd = res.headers.get('Content-Disposition') ?? '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] ?? fallbackName;
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: objectUrl, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Download failed';
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────────

export default function TdsRcmPage() {
  const session = useAdminSession();
  const isGifsy = session.role === 'GIFSY_ADMIN';

  const [clientId, setClientId] = useState(''); // GIFSY operator filter
  const [period, setPeriod] = useState(''); // 'YYYY-MM' or ''

  const [data, setData] = useState<UnregisteredResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const buildQuery = useCallback((): string => {
    const params = new URLSearchParams();
    if (clientId.trim()) params.set('clientId', clientId.trim());
    if (period.trim()) params.set('period', period.trim());
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [clientId, period]);

  const load = useCallback(async () => {
    // GIFSY-only surface: never fetch for a non-Gifsy session.
    if (!isGifsy) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/tds-reports/unregistered${buildQuery()}`, { headers: authHeader() });
      const json = (await res.json()) as { success: boolean; data?: UnregisteredResponse; error?: string };
      if (!res.ok || !json.success) {
        setError(json.error ?? `Failed to load unregistered / RCM report (HTTP ${res.status})`);
        setData(null);
        return;
      }
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load unregistered / RCM report');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [isGifsy, buildQuery]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function handleExport() {
    setExporting(true);
    setExportError('');
    const err = await downloadXlsx(
      `/api/admin/tds-reports/unregistered/export${buildQuery()}`,
      'unregistered-rcm.xlsx',
    );
    setExporting(false);
    if (err) setExportError(err);
  }

  // Not-permitted card for non-Gifsy sessions (the nav item is gifsyOnly too).
  if (!isGifsy) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4" data-testid="tds-rcm-denied">
        <p className="text-sm text-amber-800">
          The unregistered-retailer / RCM report is only available to Gifsy Platform Admins.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-10 h-10 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center">
          <FileWarning className="w-5 h-5 text-[var(--brand-primary)]" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900">Unregistered Retailers — RCM Source</h2>
          <p className="text-sm text-gray-500">
            Self-billed invoices to unregistered retailers (no GST on face) — the off-portal RCM source (D6).
          </p>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="ml-auto flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-60"
        >
          <Download className="w-3.5 h-3.5" />
          {exporting ? 'Exporting…' : 'Export Excel'}
        </button>
      </div>

      {/* RCM explainer note */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-800">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>RCM (reverse charge) is computed off-portal from this list of unregistered-retailer invoices.</span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="Client ID (optional)"
          className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
        />
        <input
          type="month"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          aria-label="Period"
        />
      </div>

      {/* Summary strip */}
      {data && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Unregistered invoices</p>
            <p className="text-base font-bold text-gray-900 mt-1">{data.count}</p>
            <p className="text-[10px] text-gray-400">RCM source rows</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Total taxable value</p>
            <p className="text-base font-bold text-gray-900 mt-1">{money(data.totals.subtotal)}</p>
            <p className="text-[10px] text-gray-400">basis for off-portal RCM</p>
          </div>
        </div>
      )}

      {/* Export error banner */}
      {exportError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 flex items-center gap-2">
          <XCircle className="w-3.5 h-3.5 flex-shrink-0" /> {exportError}
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12" aria-label="Loading">
            <div className="w-6 h-6 border-2 border-gray-200 border-t-[var(--brand-primary)] rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 m-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            <XCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-2 text-gray-400" data-testid="tds-rcm-empty">
            <FileBarChart2 className="w-8 h-8" />
            <p className="text-sm">No unregistered-retailer invoices{period ? ` for ${period}` : ''}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-100">
                  <th className="text-left px-4 py-3">Client</th>
                  <th className="text-left px-4 py-3">Invoice #</th>
                  <th className="text-left px-4 py-3">Retailer</th>
                  <th className="text-left px-4 py-3">Outlet</th>
                  <th className="text-left px-4 py-3">Period</th>
                  <th className="text-right px-4 py-3">Taxable Value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.rows.map((r, i) => (
                  <tr key={`${r.clientId}-${r.invoiceNumber}-${i}`} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-gray-600">{r.clientId}</td>
                    <td className="px-4 py-3 font-mono text-[11px] text-gray-800">{r.invoiceNumber}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{r.businessName ?? r.ownerName ?? '—'}</p>
                      <p className="text-gray-400">{r.panNumber ?? 'No PAN'}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.outletCode}</td>
                    <td className="px-4 py-3 text-gray-600">{r.period}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">{money(r.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
