'use client';

/**
 * /admin/invoices  — GIFSY_ADMIN only
 * Full invoice list with filters, "Generate invoices" action, Mark Paid, and CSV export.
 *
 * Backend:
 *   GET  /api/admin/invoices?page=&limit=&search=&period=&status=&outletCode=
 *        → { invoices, pagination: { page, limit, total, pages } }
 *   POST /api/admin/invoices/generate   body { period: "YYYY-MM" }
 *   PATCH /api/admin/invoices/:id/mark-paid
 *   PATCH /api/admin/invoices/:id/invoice-number  body { invoiceNumber }
 *
 * Money: all paise — divide by 100 for ₹ display.
 * CGST_SGST split: CGST = SGST = gstPaise / 2.
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Search,
  Filter,
  Download,
  FileText,
  ChevronRight,
  Upload,
  CheckCircle,
  Clock,
  Zap,
  Loader2,
  X,
  AlertTriangle,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { api, authHeader } from '@/lib/api-client';
import { formatINR } from '@/lib/money';
import { formatPeriodLabel } from '@/lib/invoice';

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
    // Prefer the server-provided filename (Content-Disposition) when present.
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

// ── Backend shape ─────────────────────────────────────────────────────────────
interface BackendInvoice {
  id: string;
  invoiceNumber: string;
  invoiceNumberEdited: boolean;
  partnerId: string;
  outletCode: string;
  period: string;
  invoiceDate: string;
  status: 'GENERATED' | 'PAID';
  subtotalPaise: number;
  gstPaise: number;
  gstType: 'CGST_SGST' | 'IGST' | null;
  totalPaise: number;
  createdAt: string;
  snapshot: {
    outletCode: string;
    outletName: string;
    firmName: string;
    partnerName: string;
    retailerState: string;
    retailerGstin: string | null;
    sacCode: string;
    description: string;
  };
}

// ── Server pagination envelope (canonical: { page, limit, total, pages }) ──────
interface Pagination {
  page:  number;
  limit: number;
  total: number;
  pages: number;
}

const PAGE_SIZE = 50;

// ── Generate API response ─────────────────────────────────────────────────────
interface SkippedOutlet {
  outletCode: string;
  reason: string;
}
interface GenerateResult {
  generated: number;
  skipped: SkippedOutlet[];
}

// ── Display row ───────────────────────────────────────────────────────────────
interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  outletCode: string;
  outletName: string;
  firmName: string;
  retailerState: string;
  period: string;
  periodLabel: string;
  status: 'GENERATED' | 'PAID';
  subtotalPaise: number;
  gstPaise: number;
  gstType: 'CGST_SGST' | 'IGST' | null;
  totalPaise: number;
}

function mapBackend(b: BackendInvoice): InvoiceRow {
  return {
    id:            b.id,
    invoiceNumber: b.invoiceNumber,
    outletCode:    b.snapshot.outletCode,
    outletName:    b.snapshot.outletName,
    firmName:      b.snapshot.firmName,
    retailerState: b.snapshot.retailerState,
    period:        b.period,
    periodLabel:   formatPeriodLabel(b.period),
    status:        b.status,
    subtotalPaise: b.subtotalPaise,
    gstPaise:      b.gstPaise,
    gstType:       b.gstType,
    totalPaise:    b.totalPaise,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const STATUS_STYLES: Record<InvoiceRow['status'], string> = {
  GENERATED: 'bg-amber-50 text-amber-700 border border-amber-200',
  PAID:      'bg-green-50 text-green-700 border border-green-200',
};
const STATUS_ICONS: Record<InvoiceRow['status'], React.ReactNode> = {
  GENERATED: <Clock className="w-3 h-3" />,
  PAID:      <CheckCircle className="w-3 h-3" />,
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function AdminInvoiceListPage() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [page, setPage]         = useState(1);

  const [search, setSearch]             = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'GENERATED' | 'PAID'>('ALL');
  const [periodFilter, setPeriodFilter] = useState('ALL');
  // Available periods for the dropdown — fetched ONCE (unpaginated, all statuses)
  // so the option list is complete regardless of the current page/filters.
  const [allPeriods, setAllPeriods] = useState<string[]>([]);

  // ── Generate invoices state ──────────────────────────────────────────────
  const [showGenerate, setShowGenerate]         = useState(false);
  const [generatePeriod, setGeneratePeriod]     = useState('');
  const [generating, setGenerating]             = useState(false);
  const [generateResult, setGenerateResult]     = useState<GenerateResult | null>(null);
  const [generateError, setGenerateError]       = useState<string | null>(null);

  // ── Mark paid state ──────────────────────────────────────────────────────
  const [markingPaid, setMarkingPaid]     = useState<string | null>(null); // invoice id
  const [markPaidError, setMarkPaidError] = useState<string | null>(null);

  // ── Export state ───────────────────────────────────────────────────────────
  const [exporting, setExporting]     = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // ── Fetch (server-filtered + server-paginated) ────────────────────────────
  // Sends ?page&limit&search&period&status&outletCode; the backend builds the
  // `where` (tenant-scoped) + skip/take + count and returns { invoices, pagination }.
  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (search.trim())            params.set('search', search.trim());
    if (statusFilter !== 'ALL')   params.set('status', statusFilter);
    if (periodFilter !== 'ALL')   params.set('period', periodFilter);

    const res = await api.get<{ invoices: BackendInvoice[]; pagination?: Pagination }>(
      `/api/admin/invoices?${params.toString()}`,
    );
    if (res.success) {
      setInvoices((res.data.invoices ?? []).map(mapBackend));
      setPagination(res.data.pagination ?? null);
    } else {
      setError('Failed to load invoices');
    }
    setLoading(false);
  }, [page, search, statusFilter, periodFilter]);

  // Debounced load — re-runs on page / search / status / period change.
  useEffect(() => {
    const t = setTimeout(() => { void fetchInvoices(); }, 250);
    return () => clearTimeout(t);
  }, [fetchInvoices]);

  // Any filter change resets to page 1 (the old page index is meaningless for a
  // different result set). fetchInvoices then re-fires via its `page` dep.
  useEffect(() => {
    setPage(1);
  }, [search, statusFilter, periodFilter]);

  // Period dropdown options — loaded once (all periods, unpaginated) so the list
  // is complete no matter which page/filter is active. Uses a large limit; the
  // backend caps at 100, so page through until exhausted.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const periods = new Set<string>();
      for (let p = 1; p <= 50; p++) {
        const res = await api.get<{ invoices: BackendInvoice[]; pagination?: Pagination }>(
          `/api/admin/invoices?page=${p}&limit=100`,
        );
        if (!res.success) break;
        for (const inv of res.data.invoices ?? []) periods.add(inv.period);
        const pg = res.data.pagination;
        if (!pg || p >= pg.pages || pg.pages === 0) break;
      }
      if (!cancelled) setAllPeriods(Array.from(periods).sort().reverse());
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Generate invoices ────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!generatePeriod.match(/^\d{4}-\d{2}$/)) {
      setGenerateError('Enter a valid period in YYYY-MM format.');
      return;
    }
    setGenerating(true);
    setGenerateError(null);
    setGenerateResult(null);

    const res = await api.post<GenerateResult>('/api/admin/invoices/generate', {
      period: generatePeriod,
    });
    setGenerating(false);

    if (res.success) {
      setGenerateResult(res.data);
      // Refresh the list to the generated period (server re-filters + re-paginates).
      setPeriodFilter(generatePeriod);
      setPage(1);
    } else {
      setGenerateError(res.error ?? 'Generation failed');
    }
  };

  // ── Mark paid ────────────────────────────────────────────────────────────
  const handleMarkPaid = async (id: string) => {
    setMarkingPaid(id);
    setMarkPaidError(null);

    const res = await api.patch<BackendInvoice>(`/api/admin/invoices/${id}/mark-paid`, {});
    setMarkingPaid(null);

    if (res.success) {
      setInvoices((prev) =>
        prev.map((inv) =>
          inv.id === id ? { ...inv, status: 'PAID' } : inv,
        ),
      );
    } else {
      setMarkPaidError(res.error ?? 'Failed to mark as paid');
    }
  };

  // ── Export to Excel (server-side, tenant-scoped, honours active filters) ──
  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    // Export stays UNPAGINATED (exports ALL matching rows) — deliberately never
    // sends page/limit. It DOES honour the active filters so the file matches what
    // the operator is looking at.
    const params = new URLSearchParams();
    if (search.trim())          params.set('search', search.trim());
    if (statusFilter !== 'ALL') params.set('status', statusFilter);
    if (periodFilter !== 'ALL') params.set('period', periodFilter);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const err = await downloadXlsx(`/api/admin/invoices/export${qs}`, 'visibility-invoices.xlsx');
    setExporting(false);
    if (err) setExportError(err);
  };

  // ── Computed ─────────────────────────────────────────────────────────────
  // Filtering + pagination now happen SERVER-side; `invoices` already holds the
  // current, filtered page. The summary strip sums that page (totals are labelled
  // "this page" below); the invoice count uses pagination.total for the full set.
  const totalSubtotalPaise = invoices.reduce((s, i) => s + i.subtotalPaise, 0);
  const totalGstPaise      = invoices.reduce((s, i) => s + i.gstPaise, 0);
  const totalPaise         = invoices.reduce((s, i) => s + i.totalPaise, 0);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-500">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-900">Visibility Invoices</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Auto-generated self-billing invoices for visibility payouts.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-60"
          >
            {exporting
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Download className="w-3.5 h-3.5" />}
            Export Excel
          </button>
          <button
            onClick={() => { setShowGenerate(true); setGenerateResult(null); setGenerateError(null); }}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-colors"
          >
            <Zap className="w-3.5 h-3.5" /> Generate Invoices
          </button>
          <Link
            href="/admin/invoices/upload"
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-green-700 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" /> Upload Payouts
          </Link>
        </div>
      </div>

      {/* ── Generate invoices panel ─────────────────────────────────────────── */}
      {showGenerate && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-blue-800">Generate invoices for a month</p>
            <button onClick={() => setShowGenerate(false)} className="text-blue-400 hover:text-blue-600">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="month"
              value={generatePeriod}
              onChange={(e) => {
                // input[type=month] gives "YYYY-MM"
                setGeneratePeriod(e.target.value);
                setGenerateError(null);
              }}
              className="text-xs border border-blue-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-300"
              placeholder="YYYY-MM"
            />
            <button
              onClick={handleGenerate}
              disabled={generating || !generatePeriod}
              className="flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-colors disabled:opacity-60"
            >
              {generating && <Loader2 className="w-3 h-3 animate-spin" />}
              {generating ? 'Generating…' : 'Generate'}
            </button>
          </div>
          {generateError && (
            <p className="text-xs text-red-600 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> {generateError}
            </p>
          )}
          {generateResult && (
            <div className="bg-white border border-blue-100 rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-green-700">
                <CheckCircle className="w-3.5 h-3.5 inline mr-1" />
                {generateResult.generated} invoice{generateResult.generated !== 1 ? 's' : ''} generated
              </p>
              {generateResult.skipped.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold text-amber-700 mb-1">
                    {generateResult.skipped.length} outlet{generateResult.skipped.length !== 1 ? 's' : ''} skipped:
                  </p>
                  <ul className="space-y-0.5">
                    {generateResult.skipped.map((s, i) => (
                      <li key={i} className="text-[11px] text-gray-600 flex items-start gap-1.5">
                        <span className="font-mono text-gray-700">{s.outletCode}</span>
                        <span className="text-gray-400">—</span>
                        <span>{s.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

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

      {/* Mark-paid error banner */}
      {markPaidError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {markPaidError}
          <button onClick={() => setMarkPaidError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Base Payout',   value: formatINR(totalSubtotalPaise), sub: `${invoices.length} invoices · this page` },
          { label: 'Total GST',     value: formatINR(totalGstPaise),      sub: 'this page · GST applicable only' },
          { label: 'Invoice Total', value: formatINR(totalPaise),          sub: 'this page · Base + GST' },
        ].map((s) => (
          <div key={s.label} className="bg-white border border-gray-200 rounded-xl px-4 py-3">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">{s.label}</p>
            <p className="text-base font-bold text-gray-900 mt-1">{s.value}</p>
            <p className="text-[10px] text-gray-400">{s.sub}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Search outlet, invoice number…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-2 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30 focus:border-[var(--brand-primary)]"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <Filter className="w-3.5 h-3.5" />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
        >
          <option value="ALL">All Statuses</option>
          <option value="GENERATED">Generated</option>
          <option value="PAID">Paid</option>
        </select>
        <select
          value={periodFilter}
          onChange={(e) => setPeriodFilter(e.target.value)}
          className="text-xs border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30"
        >
          <option value="ALL">All Periods</option>
          {allPeriods.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {invoices.length === 0 ? (
          <div className="py-16 flex flex-col items-center gap-2 text-gray-400">
            <FileText className="w-8 h-8" />
            <p className="text-sm">No invoices match your filters</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-100">
                  <th className="text-left px-4 py-3">Invoice #</th>
                  <th className="text-left px-4 py-3">Outlet</th>
                  <th className="text-left px-4 py-3">Period</th>
                  <th className="text-right px-4 py-3">Base Amt</th>
                  <th className="text-right px-4 py-3">GST</th>
                  <th className="text-right px-4 py-3">Total</th>
                  <th className="text-center px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-gray-700 text-[11px]">{inv.invoiceNumber}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{inv.outletName}</p>
                      <p className="text-gray-400">{inv.firmName}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{inv.periodLabel}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-800">
                      {formatINR(inv.subtotalPaise)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {inv.gstPaise > 0 ? (
                        <span className="text-green-600">
                          +{formatINR(inv.gstPaise)}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">
                      {formatINR(inv.totalPaise)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_STYLES[inv.status]}`}>
                        {STATUS_ICONS[inv.status]}
                        {inv.status.charAt(0) + inv.status.slice(1).toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {inv.status === 'GENERATED' && (
                          <button
                            onClick={() => handleMarkPaid(inv.id)}
                            disabled={markingPaid === inv.id}
                            className="text-[10px] px-2 py-1 rounded bg-green-600 text-white font-semibold hover:bg-green-700 transition-colors disabled:opacity-50 whitespace-nowrap flex items-center gap-1"
                          >
                            {markingPaid === inv.id
                              ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                              : <CheckCircle className="w-2.5 h-2.5" />
                            }
                            Mark Paid
                          </button>
                        )}
                        <Link
                          href={`/admin/invoices/${inv.id}`}
                          className="text-[var(--brand-primary)] hover:text-green-700 flex items-center"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination controls (canonical { page, limit, total, pages } envelope) */}
      {pagination && pagination.pages > 1 && (
        <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-gray-500">
          <span>
            Page <strong className="text-gray-700">{pagination.page}</strong> of{' '}
            <strong className="text-gray-700">{pagination.pages}</strong> ·{' '}
            <strong className="text-gray-700">{pagination.total}</strong> total
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pagination.page <= 1}
              className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={pagination.page >= pagination.pages}
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
