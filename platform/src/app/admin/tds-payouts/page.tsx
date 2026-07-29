'use client';

/**
 * /admin/tds-payouts — Visibility-payout TDS report (Wave 2 Stream F, spec §6)
 *
 * A read-only, filterable, paginated view of each visibility-stream payout with:
 *   outlet · GST registration type · entity type · frozen TDS section (194R/194C) ·
 *   frozen methodology (Deduct/Gross-up) · amount · TDS deducted · invoice number.
 *
 * Role scope (enforced server-side from the JWT — the query is only a hint):
 *   - CLIENT_ADMIN → own tenant only (no clientId sent; any value is ignored by the API).
 *   - GIFSY_ADMIN  → platform-wide, with an optional clientId filter.
 *
 * Backend:
 *   GET /api/admin/tds-reports/payouts[?clientId=&period=]
 *       → { scope, count, totals: { amount, tdsDeducted }, rows: [...] }
 *   GET /api/admin/tds-reports/payouts/export[?clientId=&period=]  → .xlsx
 *
 * Money: every money field is { paise: string, inr: number } (integer paise) — displayed
 * via formatINR(paise). Never fabricate data: loading spinner + error card, empty state.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Search,
  Filter,
  Download,
  Receipt,
  Loader2,
  AlertTriangle,
  X,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { api, authHeader } from '@/lib/api-client';
import { formatINR } from '@/lib/money';
import { useAdminSession } from '@/lib/admin-session';

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

// ── Backend shape (money = { paise: string, inr: number }) ────────────────────
interface Money {
  paise: string;
  inr: number;
}
interface PayoutRow {
  clientId: string;
  outletCode: string | null;
  outletName: string;
  businessName: string | null;
  panNumber: string | null;
  gstRegistrationType: string | null;
  entityType: string | null;
  fieldName: string;
  period: string;
  amount: Money;
  tdsSection: string | null;
  tdsMethodology: string | null;
  tdsDeducted: Money;
  invoiceNumber: string | null;
}
interface PayoutReport {
  scope: { clientId: string | null; period: string | null };
  count: number;
  totals: { amount: Money; tdsDeducted: Money };
  rows: PayoutRow[];
}

const PAGE_SIZE = 50;

/** Money paise may arrive as a numeric string — coerce for formatINR. */
function inrPaise(m: Money): string {
  return formatINR(Number(m.paise));
}

/** Human labels for the frozen methodology enum. */
const METHODOLOGY_LABEL: Record<string, string> = {
  DEDUCT: 'Deduct',
  GROSS_UP: 'Gross-up',
};

/** GST-registration-type badge styling. */
function gstRegBadge(type: string | null): string {
  switch (type) {
    case 'REGULAR':
    case 'COMPOSITION':
      return 'bg-green-50 text-green-700 border border-green-200';
    case 'UNREGISTERED':
      return 'bg-gray-50 text-gray-600 border border-gray-200';
    default:
      return 'bg-gray-50 text-gray-400 border border-gray-200';
  }
}

// ── SummaryCard (mirrors admin/tds) ───────────────────────────────────────────
function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
      <p className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</p>
      <p className="text-base font-bold text-gray-900 mt-1">{value}</p>
      {sub && <p className="text-[10px] text-gray-400">{sub}</p>}
    </div>
  );
}

export default function AdminTdsPayoutsPage() {
  const session = useAdminSession();
  const isGifsy = session.role === 'GIFSY_ADMIN';

  const [report, setReport] = useState<PayoutReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [periodFilter, setPeriodFilter] = useState('ALL');
  const [clientFilter, setClientFilter] = useState('ALL'); // GIFSY only
  const [page, setPage] = useState(1);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // ── Fetch the full scoped report once. CLIENT_ADMIN is pinned to its tenant by
  //    the API; GIFSY fetches platform-wide and filters client-side. Sending no
  //    clientId keeps the fetch platform-wide so the client dropdown is complete.
  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.get<PayoutReport>('/api/admin/tds-reports/payouts');
    if (res.success) {
      setReport(res.data);
    } else {
      setError(res.error && res.error !== 'Network error' ? res.error : 'Failed to load payout report');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetchReport();
  }, [fetchReport]);

  // Any filter change resets to page 1.
  useEffect(() => {
    setPage(1);
  }, [search, periodFilter, clientFilter]);

  const rows = useMemo(() => report?.rows ?? [], [report]);

  // Distinct period + client options derived from the fetched rows (no fabrication).
  const periodOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.period))).sort().reverse(),
    [rows],
  );
  const clientOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.clientId))).sort(),
    [rows],
  );

  // Client-side filtering over the fetched rows.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (periodFilter !== 'ALL' && r.period !== periodFilter) return false;
      if (isGifsy && clientFilter !== 'ALL' && r.clientId !== clientFilter) return false;
      if (!q) return true;
      return (
        (r.outletName ?? '').toLowerCase().includes(q) ||
        (r.outletCode ?? '').toLowerCase().includes(q) ||
        (r.businessName ?? '').toLowerCase().includes(q) ||
        (r.panNumber ?? '').toLowerCase().includes(q) ||
        (r.invoiceNumber ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, search, periodFilter, clientFilter, isGifsy]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Totals for the currently-filtered set (paise, summed as numbers).
  const totalAmountPaise = filtered.reduce((s, r) => s + Number(r.amount.paise), 0);
  const totalTdsPaise = filtered.reduce((s, r) => s + Number(r.tdsDeducted.paise), 0);

  // ── Export (honours active period + GIFSY client filter; server-side xlsx) ──
  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    const params = new URLSearchParams();
    if (periodFilter !== 'ALL') params.set('period', periodFilter);
    if (isGifsy && clientFilter !== 'ALL') params.set('clientId', clientFilter);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const err = await downloadXlsx(`/api/admin/tds-reports/payouts/export${qs}`, 'tds-payouts.xlsx');
    setExporting(false);
    if (err) setExportError(err);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen" aria-label="Loading">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 flex items-center gap-2 m-4">
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[var(--brand-primary)]/10 flex items-center justify-center">
            <Receipt className="w-5 h-5 text-[var(--brand-primary)]" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Visibility Payout — TDS Report</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {isGifsy
                ? 'Platform-wide visibility payouts with GST reg type + frozen TDS treatment.'
                : 'Your visibility payouts with GST reg type + frozen TDS treatment (read-only).'}
            </p>
          </div>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-60"
        >
          {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          Export Excel
        </button>
      </div>

      {/* Export error banner */}
      {exportError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {exportError}
          <button onClick={() => setExportError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Summary strip (filtered set) */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Payouts" value={String(filtered.length)} sub="matching filters" />
        <SummaryCard label="Total Amount" value={formatINR(totalAmountPaise)} sub="filtered set" />
        <SummaryCard label="TDS Deducted" value={formatINR(totalTdsPaise)} sub="filtered set" />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Search outlet, business, PAN, invoice number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30 focus:border-[var(--brand-primary)]"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <Filter className="w-3.5 h-3.5" />
        </div>
        {isGifsy && (
          <select
            value={clientFilter}
            onChange={(e) => setClientFilter(e.target.value)}
            className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
          >
            <option value="ALL">All Tenants</option>
            {clientOptions.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
        <select
          value={periodFilter}
          onChange={(e) => setPeriodFilter(e.target.value)}
          className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
        >
          <option value="ALL">All Periods</option>
          {periodOptions.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-2 text-gray-400">
            <Receipt className="w-8 h-8" />
            <p className="text-sm">No visibility payouts match your filters</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-100">
                  {isGifsy && <th className="text-left px-4 py-3">Tenant</th>}
                  <th className="text-left px-4 py-3">Outlet</th>
                  <th className="text-left px-4 py-3">GST Reg</th>
                  <th className="text-left px-4 py-3">Entity</th>
                  <th className="text-left px-4 py-3">Period</th>
                  <th className="text-center px-4 py-3">Section</th>
                  <th className="text-center px-4 py-3">Methodology</th>
                  <th className="text-right px-4 py-3">Amount</th>
                  <th className="text-right px-4 py-3">TDS Deducted</th>
                  <th className="text-left px-4 py-3">Invoice #</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {pageRows.map((r, i) => (
                  <tr key={`${r.clientId}-${r.outletCode}-${r.period}-${i}`} className="hover:bg-gray-50 transition-colors">
                    {isGifsy && <td className="px-4 py-3 text-gray-600">{r.clientId}</td>}
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{r.outletName}</p>
                      <p className="text-gray-400">{r.businessName ?? r.outletCode ?? '—'}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${gstRegBadge(r.gstRegistrationType)}`}>
                        {r.gstRegistrationType ?? '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.entityType ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-600">{r.period}</td>
                    <td className="px-4 py-3 text-center text-gray-700">{r.tdsSection ?? '—'}</td>
                    <td className="px-4 py-3 text-center text-gray-700">
                      {r.tdsMethodology ? (METHODOLOGY_LABEL[r.tdsMethodology] ?? r.tdsMethodology) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-gray-800">{inrPaise(r.amount)}</td>
                    <td className="px-4 py-3 text-right">
                      {Number(r.tdsDeducted.paise) > 0 ? (
                        <span className="text-red-600 font-medium">{inrPaise(r.tdsDeducted)}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-gray-600">{r.invoiceNumber ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination (client-side over the filtered set) */}
      {pages > 1 && (
        <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-gray-500">
          <span>
            Page <strong className="text-gray-700">{page}</strong> of{' '}
            <strong className="text-gray-700">{pages}</strong> ·{' '}
            <strong className="text-gray-700">{filtered.length}</strong> total
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
