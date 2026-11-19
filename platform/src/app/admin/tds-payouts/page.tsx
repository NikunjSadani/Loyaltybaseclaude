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

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Search,
  Filter,
  Download,
  Receipt,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/lib/api-client';
import { formatInrPaise as formatINR } from '@/lib/money-format';
import { useAdminSession } from '@/lib/admin-session';
import { downloadButtonLabel, useDownloadAction } from '@/lib/exports/use-download-action';
import { DownloadActionStatus } from '@/components/exports/download-action-status';

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
  /** Tenant display name (newer API). */
  clientName?: string;
  /** This payout was reversed later — API-authored, shown verbatim. */
  reversedNote?: string;
  /** TDS lowered on this payout by a TDS credit (integer paise). */
  tdsCreditAppliedPaise?: number;
  /** Why TDS was lowered (credit / below-limit adjustment) — API-authored, shown verbatim. */
  tdsNote?: string;
}
/** Policy round B: a TDS credit from a reversed PAID payout + its uses against later payouts' TDS. */
interface TdsCreditRow {
  creditId: string;
  clientId: string;
  clientName?: string | null;
  panNumber: string;
  /** Masked PAN from the API (XXXXX1234F) — preferred over masking here. */
  panMasked?: string;
  /** L2 — "Scoped to FY 2026-27 · 194C · usable by any programme on this PAN". */
  scopeNote?: string;
  /** D2 — "₹X unused credit for FY 2025-26, not carried forward". */
  unusedNote?: string | null;
  /** L6 — "Credit on previous PAN XXXXX1234F — not applied automatically". */
  previousPanNote?: string | null;
  section: string;
  fyLabel: string;
  createdAt: string;
  sourceOutletCode: string | null;
  sourceOutletName: string | null;
  sourcePeriod: string | null;
  credit: Money;
  applied: Money;
  outstanding: Money;
  applications: Array<{
    applicationId: string;
    appliedAt: string;
    amount: Money;
    outletName: string | null;
    period: string | null;
    released: boolean;
    releaseReason: string | null;
    /** 194C: used against a payout of another programme on the same PAN. */
    otherProgramme?: boolean;
    note?: string;
  }>;
}
interface TdsCredits {
  count: number;
  totals: { created: Money; applied: Money; outstanding: Money };
  rows: TdsCreditRow[];
  /** Server-side pagination of `rows` (creditPage / creditLimit); absent on an older API. */
  pagination?: { page: number; limit: number; total: number; pages: number };
  /** Summary call-outs, API-authored. */
  notes?: string[];
}
interface PayoutReport {
  scope: { clientId: string | null; period: string | null };
  count: number;
  totals: { amount: Money; tdsDeducted: Money };
  rows: PayoutRow[];
  /** Absent on an older API. */
  tdsCredits?: TdsCredits;
}

/** PAN shown masked on screen (XXXXX1234F). */
const maskPan = (pan: string) => (pan.length >= 5 ? `XXXXX${pan.slice(5)}` : pan);

const PAGE_SIZE = 50;
const ZERO_MONEY: Money = { paise: '0', inr: 0 };
const EMPTY_CREDITS: TdsCredits = { count: 0, totals: { created: ZERO_MONEY, applied: ZERO_MONEY, outstanding: ZERO_MONEY }, rows: [] };
/** TDS credits panel page size (server-side; API default 25, max 100). */
const CREDIT_PAGE_SIZE = 25;

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

  const exportAction = useDownloadAction();

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

  // ── TDS credits panel: SERVER-paginated (#21) and scoped by the page's tenant / period filters. Page 1 with no
  //    filter comes with the report itself; any other page / filter is fetched (only its tdsCredits block is used).
  const [creditPage, setCreditPage] = useState(1);
  const [credits, setCredits] = useState<TdsCredits | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const creditReq = useRef(0);

  useEffect(() => {
    setCreditPage(1);
  }, [periodFilter, clientFilter]);

  useEffect(() => {
    if (!report) return;
    const id = ++creditReq.current;
    const clientId = isGifsy && clientFilter !== 'ALL' ? clientFilter : '';
    const period = periodFilter !== 'ALL' ? periodFilter : '';
    if (creditPage === 1 && !clientId && !period) {
      setCredits(report.tdsCredits ?? null);
      setCreditsError(null);
      setCreditsLoading(false);
      return;
    }
    // creditsOnly: a page flip reads just the credits block, never every payout row again.
    const q = new URLSearchParams({ creditPage: String(creditPage), creditLimit: String(CREDIT_PAGE_SIZE), creditsOnly: 'true' });
    if (clientId) q.set('clientId', clientId);
    if (period) q.set('period', period);
    setCreditsLoading(true);
    void api.get<PayoutReport>(`/api/admin/tds-reports/payouts?${q.toString()}`).then((res) => {
      if (id !== creditReq.current) return; // superseded by a newer page / filter
      if (res.success) {
        // An absent block for a filtered page means "none" — never fall back to the unfiltered credits.
        setCredits(res.data.tdsCredits ?? EMPTY_CREDITS);
        setCreditsError(null);
      } else {
        setCreditsError(res.error && res.error !== 'Network error' ? res.error : "Couldn't load TDS credits");
      }
      setCreditsLoading(false);
    });
  }, [report, creditPage, periodFilter, clientFilter, isGifsy]);

  const rows = useMemo(() => report?.rows ?? [], [report]);
  // Tenant display names (newer API sends clientName; fall back to the id).
  const clientNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.clientName) m.set(r.clientId, r.clientName);
    return m;
  }, [rows]);
  const tenantLabel = (clientId: string, name?: string | null) => name || clientNames.get(clientId) || clientId;
  // The panel exists when the tenant scope has any TDS credit at all (a filter may narrow it to none).
  const hasAnyCredits = (report?.tdsCredits?.pagination?.total ?? report?.tdsCredits?.count ?? 0) > 0;
  // Before the first effect run, show the credits that came with the report (no empty flash).
  const shownCredits = credits ?? report?.tdsCredits ?? null;
  const creditPg = shownCredits?.pagination;

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
  const handleExport = () => {
    const params = new URLSearchParams();
    if (periodFilter !== 'ALL') params.set('period', periodFilter);
    if (isGifsy && clientFilter !== 'ALL') params.set('clientId', clientFilter);
    const qs = params.toString() ? `?${params.toString()}` : '';
    // 200 → saves straight away; 202 → prepared in the background (Downloads page).
    void exportAction.run(`/api/admin/tds-reports/payouts/export${qs}`, { fallbackFileName: 'tds-payouts.xlsx' });
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
        <div className="flex flex-col items-end gap-1.5 max-w-xs">
          <button
            onClick={handleExport}
            disabled={exportAction.blocked}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-60"
          >
            {exportAction.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            {downloadButtonLabel(exportAction, 'Export Excel')}
          </button>
          {/* Queued / error message — directly below the button. */}
          <DownloadActionStatus action={exportAction} />
        </div>
      </div>

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
              <option key={c} value={c}>{tenantLabel(c)}</option>
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
                    {isGifsy && <td className="px-4 py-3 text-gray-600">{tenantLabel(r.clientId, r.clientName)}</td>}
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{r.outletName}</p>
                      <p className="text-gray-400">{r.businessName ?? r.outletCode ?? '—'}</p>
                      {r.reversedNote && (
                        <p data-testid="tds-row-reversed-note" className="mt-1 inline-block rounded bg-amber-50 border border-amber-200 px-1.5 py-0.5 text-[11px] text-amber-800 max-w-xs whitespace-normal">
                          Reversed — {r.reversedNote}
                        </p>
                      )}
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
                      {(r.tdsNote || (r.tdsCreditAppliedPaise ?? 0) > 0) && (
                        <span data-testid="tds-row-tds-note" className="block text-[11px] text-blue-700 whitespace-normal max-w-xs ml-auto">
                          {r.tdsNote ?? `${formatINR(r.tdsCreditAppliedPaise ?? 0)} covered by TDS credit`}
                        </span>
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

      {/* Policy round B: TDS credits from reversed PAID payouts — created / applied / outstanding (never silent).
          Server-paginated (#21) and scoped by the tenant / period filters above. */}
      {hasAnyCredits && (
        <div data-testid="tds-credits-panel" className="bg-white border border-blue-200 rounded-xl p-4 space-y-3" aria-busy={creditsLoading || undefined}>
          <div>
            <h2 className="text-sm font-semibold text-gray-900">TDS credits from reversed payouts</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              When an already-paid payout is reversed, the TDS withheld from it stays deposited with the government. It is
              carried forward on that PAN for the same financial year and adjusted against the next TDS deducted for it
              (see each credit&apos;s scope below).
            </p>
          </div>
          {creditsError && (
            <div role="alert" className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              {creditsError}
            </div>
          )}
          {shownCredits && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <SummaryCard label="Credit created" value={inrPaise(shownCredits.totals.created)} />
                <SummaryCard label="Adjusted so far" value={inrPaise(shownCredits.totals.applied)} />
                <SummaryCard label="Still to adjust" value={inrPaise(shownCredits.totals.outstanding)} sub="carried forward" />
              </div>
              {(shownCredits.notes?.length ?? 0) > 0 && (
                <ul data-testid="tds-credits-notes" className="list-disc pl-5 text-xs text-blue-800 space-y-0.5">
                  {shownCredits.notes!.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
              {shownCredits.rows.length === 0 ? (
                <p className="text-xs text-gray-500">No TDS credits match these filters.</p>
              ) : (
                <ul className={`space-y-2 text-xs text-gray-700 ${creditsLoading ? 'opacity-60' : ''}`}>
                  {shownCredits.rows.map((c) => (
                    <li key={c.creditId} data-testid={`tds-credit-${c.creditId}`} className="border border-gray-100 rounded-lg px-3 py-2 space-y-1 break-words">
                      <p>
                        {isGifsy && <span className="text-gray-500">{tenantLabel(c.clientId, c.clientName)} · </span>}
                        PAN {c.panMasked ?? maskPan(c.panNumber)} · {c.section} · FY {c.fyLabel} — {inrPaise(c.credit)} credit from the reversed
                        payout of {c.sourceOutletName ?? c.sourceOutletCode ?? '—'} ({c.sourcePeriod ?? '—'}) ·{' '}
                        <strong>{inrPaise(c.outstanding)} still to adjust</strong>
                      </p>
                      {c.scopeNote && (
                        <p className="inline-block rounded bg-blue-50 border border-blue-200 px-1.5 py-0.5 text-[11px] text-blue-800">{c.scopeNote}</p>
                      )}
                      {c.unusedNote && <p className="text-amber-800">{c.unusedNote}</p>}
                      {c.previousPanNote && <p className="text-amber-800">{c.previousPanNote}</p>}
                      {c.applications.length > 0 && (
                        <ul className="list-disc pl-5 text-gray-500">
                          {c.applications.map((a) => (
                            <li key={a.applicationId}>
                              {a.released
                                ? `${inrPaise(a.amount)} had been adjusted on ${a.outletName ?? '—'} (${a.period ?? '—'}) — returned, that payout did not go through`
                                : `${inrPaise(a.amount)} adjusted from this credit against the TDS of ${a.outletName ?? '—'} (${a.period ?? '—'})`}
                              {a.otherProgramme && (
                                <span className="ml-1 inline-block rounded bg-blue-100 px-1.5 text-[10px] font-medium text-blue-800">another programme</span>
                              )}
                              {a.note && <span className="block text-gray-600">{a.note}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {creditPg && creditPg.pages > 1 && (
                <nav aria-label="TDS credits pages" className="flex items-center justify-between gap-3 flex-wrap text-xs text-gray-500">
                  <span data-testid="tds-credits-range">
                    Page <strong className="text-gray-700">{creditPg.page}</strong> of{' '}
                    <strong className="text-gray-700">{creditPg.pages}</strong> ·{' '}
                    <strong className="text-gray-700">{creditPg.total}</strong> credits
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setCreditPage(Math.max(1, creditPg.page - 1))}
                      disabled={creditsLoading || creditPg.page <= 1}
                      className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreditPage(creditPg.page + 1)}
                      disabled={creditsLoading || creditPg.page >= creditPg.pages}
                      className="px-3 py-1.5 font-medium border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Next
                    </button>
                  </div>
                </nav>
              )}
            </>
          )}
        </div>
      )}

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
