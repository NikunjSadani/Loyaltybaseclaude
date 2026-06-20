'use client';

/**
 * /partner/invoices — Retailer's invoice list
 * Shows gross amount only. No TDS, no 194C, no tax breakdown.
 * Dismissible info banner explaining self-billing.
 *
 * Backend: GET /api/partner/invoices → { success, data: Invoice[] }
 * Money:   all amounts are integer paise — divide by 100 for ₹ display.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  FileText,
  ChevronRight,
  Info,
  X,
  CheckCircle,
  Clock,
  Download,
  Loader2,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { api, authHeader } from '@/lib/api-client';
import { formatINR } from '@/lib/money';
import { formatPeriodLabel } from '@/lib/invoice';

/** Trigger a browser download of the partner's own invoice export (.xlsx). */
async function downloadInvoicesXlsx(): Promise<string | null> {
  try {
    const res = await fetch('/api/partner/invoices/export', { headers: authHeader() });
    if (!res.ok) return `HTTP ${res.status}`;
    const cd = res.headers.get('Content-Disposition') ?? '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] ?? 'my-invoices.xlsx';
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

// ── Backend shape (subset we care about for list) ─────────────────────────────
interface BackendInvoice {
  id: string;
  invoiceNumber: string;
  period: string;          // "YYYY-MM"
  status: 'GENERATED' | 'PAID';
  subtotalPaise: number;
  gstPaise: number;
  totalPaise: number;
  snapshot: {
    description?: string;
  };
}

// ── Display-only shape ────────────────────────────────────────────────────────
interface InvoiceListItem {
  id: string;
  invoiceNumber: string;
  periodLabel: string;
  description: string;
  totalPaise: number;
  status: 'GENERATED' | 'PAID';
}

function mapBackendInvoice(b: BackendInvoice): InvoiceListItem {
  return {
    id:            b.id,
    invoiceNumber: b.invoiceNumber,
    periodLabel:   formatPeriodLabel(b.period),
    description:   b.snapshot?.description ?? `Marketing visibility services — ${formatPeriodLabel(b.period)}`,
    totalPaise:    b.totalPaise,
    status:        b.status,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const STATUS_STYLES = {
  GENERATED: 'bg-amber-50 text-amber-700',
  PAID:      'bg-green-50 text-green-700',
};
const STATUS_LABEL = {
  GENERATED: 'Processing',
  PAID:      'Paid',
};

export default function PartnerInvoiceListPage() {
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [invoices, setInvoices]               = useState<InvoiceListItem[]>([]);
  const [loading, setLoading]                 = useState(true);
  const [error, setError]                     = useState<string | null>(null);
  const [exporting, setExporting]             = useState(false);
  const [exportError, setExportError]         = useState<string | null>(null);

  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    const err = await downloadInvoicesXlsx();
    setExporting(false);
    if (err) setExportError(err);
  };

  useEffect(() => {
    // Backend list() returns { invoices, pagination } — read the array off it.
    api.get<{ invoices: BackendInvoice[] }>('/api/partner/invoices')
      .then((res) => {
        if (res.success) {
          setInvoices((res.data.invoices ?? []).map(mapBackendInvoice));
        } else {
          setError('Failed to load invoices');
        }
      })
      .catch(() => setError('Failed to load invoices'))
      .finally(() => setLoading(false));
  }, []);

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
        <p className="text-gray-500 text-sm">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-bold text-gray-900">My Invoices</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Visibility service invoices raised on your behalf
          </p>
        </div>
        {invoices.length > 0 && (
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-60 flex-shrink-0"
          >
            {exporting
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Download className="w-3.5 h-3.5" />}
            Export Excel
          </button>
        )}
      </div>

      {exportError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700">
          {exportError}
        </div>
      )}

      {/* Info banner — dismissible */}
      {!bannerDismissed && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex gap-3">
          <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1 text-xs text-blue-700">
            <p className="font-semibold mb-0.5">About your invoices</p>
            <p>
              These invoices are automatically generated by Tech Gifsy Solutions Limited on
              your behalf for marketing visibility services you have provided. No signature
              is required. Please download and retain these for your records.
            </p>
          </div>
          <button
            onClick={() => setBannerDismissed(true)}
            className="text-blue-400 hover:text-blue-600 flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Invoice list */}
      {invoices.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl py-16 flex flex-col items-center gap-3 text-gray-400">
          <FileText className="w-10 h-10" />
          <p className="text-sm font-medium">No invoices yet</p>
          <p className="text-xs">Invoices will appear here once payouts are approved.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {invoices.map((inv) => (
            <Link
              key={inv.id}
              href={`/partner/invoices/${inv.id}`}
              className="block bg-white border border-gray-200 rounded-xl p-4 hover:shadow-sm transition-shadow"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {/* Invoice number */}
                  <p className="text-[11px] font-mono text-gray-400 truncate">{inv.invoiceNumber}</p>
                  {/* Period + description */}
                  <p className="text-sm font-semibold text-gray-800 mt-0.5">{inv.periodLabel}</p>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{inv.description}</p>
                </div>
                <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                  {/* Gross invoice total — paise ÷ 100 */}
                  <p className="text-base font-bold text-gray-900">
                    {formatINR(inv.totalPaise)}
                  </p>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full flex items-center gap-1 ${STATUS_STYLES[inv.status]}`}>
                    {inv.status === 'PAID'
                      ? <CheckCircle className="w-2.5 h-2.5" />
                      : <Clock className="w-2.5 h-2.5" />
                    }
                    {STATUS_LABEL[inv.status]}
                  </span>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0 self-center" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
