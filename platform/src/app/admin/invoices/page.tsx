'use client';

/**
 * /admin/invoices  — GIFSY_ADMIN only
 * Full invoice list with filter, status badge, and CSV export.
 */

import { useState, useMemo } from 'react';
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
} from 'lucide-react';
import { MOCK_VISIBILITY_INVOICES, type VisibilityInvoice } from '@/lib/invoice';

// ── Helpers ───────────────────────────────────────────────────────────────────
const STATUS_STYLES: Record<VisibilityInvoice['status'], string> = {
  GENERATED: 'bg-amber-50 text-amber-700 border border-amber-200',
  PAID: 'bg-green-50 text-green-700 border border-green-200',
};
const STATUS_ICONS: Record<VisibilityInvoice['status'], React.ReactNode> = {
  GENERATED: <Clock className="w-3 h-3" />,
  PAID: <CheckCircle className="w-3 h-3" />,
};

function exportCSV(invoices: VisibilityInvoice[]) {
  const headers = [
    'Invoice Number', 'Outlet ID', 'Outlet Name', 'Firm Name', 'State',
    'Period', 'Base Amount', 'GST Type', 'Total GST', 'Invoice Total',
    'Status', 'Generated At', 'Paid At',
  ];
  const rows = invoices.map((inv) => [
    inv.invoiceNumber,
    inv.outletId,
    inv.outletName,
    inv.firmName,
    inv.retailerState,
    inv.periodLabel,
    inv.baseAmount,
    inv.gstType ?? 'N/A',
    inv.totalGST,
    inv.totalInvoiceAmount,
    inv.status,
    inv.generatedAt,
    inv.paidAt ?? '',
  ]);

  const csv = [headers, ...rows]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `visibility-invoices-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function AdminInvoiceListPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | VisibilityInvoice['status']>('ALL');
  const [periodFilter, setPeriodFilter] = useState('ALL');

  const allPeriods = useMemo(() => {
    const s = new Set(MOCK_VISIBILITY_INVOICES.map((i) => i.period));
    return Array.from(s).sort().reverse();
  }, []);

  const filtered = useMemo(() => {
    return MOCK_VISIBILITY_INVOICES.filter((inv) => {
      if (statusFilter !== 'ALL' && inv.status !== statusFilter) return false;
      if (periodFilter !== 'ALL' && inv.period !== periodFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          inv.invoiceNumber.toLowerCase().includes(q) ||
          inv.outletName.toLowerCase().includes(q) ||
          inv.firmName.toLowerCase().includes(q) ||
          inv.outletId.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [search, statusFilter, periodFilter]);

  const totalBase = filtered.reduce((s, i) => s + i.baseAmount, 0);
  const totalGST = filtered.reduce((s, i) => s + i.totalGST, 0);
  const totalInvoice = filtered.reduce((s, i) => s + i.totalInvoiceAmount, 0);

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
            onClick={() => exportCSV(filtered)}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <Download className="w-3.5 h-3.5" /> Export CSV
          </button>
          <Link
            href="/admin/invoices/upload"
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-green-700 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" /> Upload Payouts
          </Link>
        </div>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Base Payout', value: `₹${totalBase.toLocaleString('en-IN')}`, sub: `${filtered.length} invoices` },
          { label: 'Total GST', value: `₹${totalGST.toLocaleString('en-IN')}`, sub: 'GST applicable only' },
          { label: 'Invoice Total', value: `₹${totalInvoice.toLocaleString('en-IN')}`, sub: 'Base + GST' },
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
        {filtered.length === 0 ? (
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
                {filtered.map((inv) => (
                  <tr key={inv.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-gray-700 text-[11px]">{inv.invoiceNumber}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-800">{inv.outletName}</p>
                      <p className="text-gray-400">{inv.firmName}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{inv.periodLabel}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-800">
                      ₹{inv.baseAmount.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {inv.gstApplicable ? (
                        <span className="text-green-600">
                          +₹{inv.totalGST.toLocaleString('en-IN')}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">
                      ₹{inv.totalInvoiceAmount.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_STYLES[inv.status]}`}>
                        {STATUS_ICONS[inv.status]}
                        {inv.status.charAt(0) + inv.status.slice(1).toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/invoices/${inv.id}`}
                        className="text-[var(--brand-primary)] hover:text-green-700 flex items-center"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Link>
                    </td>
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
