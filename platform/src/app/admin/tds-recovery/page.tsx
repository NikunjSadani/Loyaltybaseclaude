'use client';

/**
 * /admin/tds-recovery — TDS liability + tenant-wise recovery / attribution report
 * (Wave 2 Stream E, design D10 / D11 / §6).
 *
 * The GROSS_UP pro-rata tenant recovery ledger ("in lieu of TDS deduction"). Dashboard/report
 * ONLY — this tag never appears on an invoice face (D11). Each row is one (client, PAN, FY)
 * attribution of the grossed-up TDS that Gifsy recovers from the tenant, pro-rata by the tenant's
 * share of the retailer's cross-tenant aggregate.
 *
 * Role scope (enforced server-side, mirrored here):
 *   - CLIENT_ADMIN — pinned to their own tenant; the page NEVER sends a clientId (the backend
 *     ignores it anyway), so a tenant admin sees only its own recovery liability.
 *   - GIFSY_ADMIN  — platform-wide, with an optional ?clientId= filter to scope to one tenant.
 *
 * Backend:
 *   GET /api/admin/tds-reports/recovery[?clientId=&fy=YYYY-YY]
 *       → { label, scope, count, totals:{ tenantShare, noPanTenantShare }, rows:[…] }
 *   GET /api/admin/tds-reports/recovery/export[?clientId=&fy=YYYY-YY]  → xlsx
 *
 * No-PAN rows: the backend flags them with isNoPan (derived from a '__NO_PAN__…' sentinel in the
 * PAN cell). This page reads the FLAG, never the raw sentinel, and labels those rows clearly.
 *
 * Money: paise arrives as { paise, inr }; rendered via formatINR (paise number) — exact, no
 * fabricated numbers on error.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Landmark,
  Download,
  ChevronDown,
  XCircle,
  FileBarChart2,
} from 'lucide-react';
import { useAdminSession } from '@/lib/admin-session';
import { authHeader } from '@/lib/api-client';
import { formatINR } from '@/lib/money';

// ─── Backend shapes ─────────────────────────────────────────────────────────────

interface Money {
  paise: string;
  inr: number;
}

interface RecoveryRow {
  clientId: string;
  panNumber: string;
  isNoPan: boolean;
  section: string;
  fyLabel: string;
  tdsInvoiceId: string | null;
  panTdsTotal: Money;
  tenantBase: Money;
  panBase: Money;
  tenantShare: Money;
  createdAt: string;
}

interface RecoveryResponse {
  label: string;
  scope: { clientId: string | null; fy: string | null };
  count: number;
  totals: { tenantShare: Money; noPanTenantShare: Money };
  rows: RecoveryRow[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

function money(m: Money): string {
  return formatINR(Number(m.paise));
}

/** Current + recent financial years as "YYYY-YY" (FY starts April). */
function buildFyOptions(): string[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const startYear = month >= 4 ? year : year - 1;
  return [0, 1, 2].map((offset) => {
    const s = startYear - offset;
    return `${s}-${String(s + 1).slice(-2)}`;
  });
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

export default function TdsRecoveryPage() {
  const session = useAdminSession();
  const isGifsy = session.role === 'GIFSY_ADMIN';

  const fyOptions = buildFyOptions();
  const [fy, setFy] = useState<string>(''); // '' = all FYs
  const [clientId, setClientId] = useState(''); // GIFSY-only filter

  const [data, setData] = useState<RecoveryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  /**
   * Build the query string. CLIENT_ADMIN NEVER contributes a clientId (server pins it to the
   * caller's own tenant); only GIFSY may scope to one tenant.
   */
  const buildQuery = useCallback((): string => {
    const params = new URLSearchParams();
    if (fy) params.set('fy', fy);
    if (isGifsy && clientId.trim()) params.set('clientId', clientId.trim());
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }, [fy, isGifsy, clientId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/tds-reports/recovery${buildQuery()}`, { headers: authHeader() });
      const json = (await res.json()) as { success: boolean; data?: RecoveryResponse; error?: string };
      if (!res.ok || !json.success) {
        setError(json.error ?? `Failed to load recovery report (HTTP ${res.status})`);
        setData(null);
        return;
      }
      setData(json.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recovery report');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [buildQuery]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function handleExport() {
    setExporting(true);
    setExportError('');
    const err = await downloadXlsx(
      `/api/admin/tds-reports/recovery/export${buildQuery()}`,
      'tds-recovery.xlsx',
    );
    setExporting(false);
    if (err) setExportError(err);
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="w-10 h-10 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center">
          <Landmark className="w-5 h-5 text-[var(--brand-primary)]" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-gray-900">TDS Recovery &amp; Attribution</h2>
          <p className="text-sm text-gray-500">
            Grossed-up TDS recovered from tenants, pro-rata — <em>in lieu of TDS deduction</em> (D10).
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

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <select
            aria-label="Financial Year"
            value={fy}
            onChange={(e) => setFy(e.target.value)}
            className="border border-gray-200 rounded-lg pl-3 pr-8 py-2 text-xs text-gray-700 bg-white focus:outline-none focus:border-gray-400 appearance-none"
          >
            <option value="">All Financial Years</option>
            {fyOptions.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-2.5 w-4 h-4 text-gray-400" />
        </div>
        {isGifsy && (
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="Client ID (optional)"
            className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          />
        )}
      </div>

      {/* Summary strip */}
      {data && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Total — in lieu of TDS</p>
            <p className="text-base font-bold text-gray-900 mt-1">{money(data.totals.tenantShare)}</p>
            <p className="text-[10px] text-gray-400">{data.count} attribution row{data.count !== 1 ? 's' : ''}</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">of which No-PAN</p>
            <p className="text-base font-bold text-gray-900 mt-1">{money(data.totals.noPanTenantShare)}</p>
            <p className="text-[10px] text-gray-400">no-PAN recovery obligation</p>
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
          <div className="py-16 flex flex-col items-center gap-2 text-gray-400" data-testid="tds-recovery-empty">
            <FileBarChart2 className="w-8 h-8" />
            <p className="text-sm">No recovery / attribution rows{fy ? ` for ${fy}` : ''}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-100">
                  {isGifsy && <th className="text-left px-4 py-3">Client</th>}
                  <th className="text-left px-4 py-3">PAN</th>
                  <th className="text-left px-4 py-3">Section</th>
                  <th className="text-left px-4 py-3">FY</th>
                  <th className="text-right px-4 py-3">PAN TDS Total</th>
                  <th className="text-right px-4 py-3">Tenant Base</th>
                  <th className="text-right px-4 py-3">PAN Base</th>
                  <th className="text-right px-4 py-3">Tenant Share (in lieu of TDS)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {data.rows.map((r, i) => (
                  <tr key={`${r.clientId}-${r.panNumber}-${r.fyLabel}-${i}`} className="hover:bg-gray-50 transition-colors">
                    {isGifsy && <td className="px-4 py-3 text-gray-600">{r.clientId}</td>}
                    <td className="px-4 py-3 font-mono text-[11px] text-gray-800">
                      {r.isNoPan ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-sans font-medium">
                          No PAN
                        </span>
                      ) : (
                        r.panNumber || '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.section}</td>
                    <td className="px-4 py-3 text-gray-600">{r.fyLabel}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{money(r.panTdsTotal)}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{money(r.tenantBase)}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{money(r.panBase)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">{money(r.tenantShare)}</td>
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
