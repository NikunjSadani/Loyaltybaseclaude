'use client';

/**
 * /admin/invoices/[id]
 * Operator invoice-detail view (the missing route the list-page arrow linked to).
 *
 * - Read-only self-billed invoice: retailer (service provider) → Tech Gifsy (recipient).
 * - GIFSY_ADMIN may Mark Paid while status = GENERATED (mirrors the list page); a
 *   CLIENT_ADMIN gets the same read-only view (the API scopes it to their tenant).
 * - Invoice-number editing is intentionally NOT here — that is the partner-only flow.
 * - TDS is never surfaced on a service invoice (internal-only, per the invoice module).
 *
 * Backend (via the FE proxy /api → /v1):
 *   GET   /api/admin/invoices/:id             → the raw AutoInvoice record
 *   PATCH /api/admin/invoices/:id/mark-paid   → GENERATED → PAID (GIFSY only)
 *
 * Money: all *Paise fields are integer paise (BigInt on the server, serialised to
 * JSON numbers via BigInt.prototype.toJSON). Divide by 100 for ₹ display.
 * CGST_SGST split: CGST = SGST = gstPaise / 2.
 */

import { useState, useEffect, use } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  AlertTriangle,
  CheckCircle,
  Clock,
  FileText,
  Loader2,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { api, authHeader } from '@/lib/api-client';
import { formatINR } from '@/lib/money';
import { formatPeriodLabel } from '@/lib/invoice';
import { useAdminSession } from '@/lib/admin-session';

// ── Backend shape (raw AutoInvoice; snapshot frozen at generation time) ─────────
interface BackendInvoice {
  id: string;
  invoiceNumber: string;
  invoiceNumberEdited: boolean;
  partnerId: string;
  outletCode: string;
  period: string;
  invoiceDate: string;
  status: 'GENERATED' | 'PAID';
  invoiceKind?: 'SERVICE' | 'TDS';
  lockedAt?: string | null;
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
    mobile?: string;
    retailerState: string;
    retailerGstin: string | null;
    panNumber: string | null;
    entityType?: string | null;
    gstRegistrationType?: string | null;
    sacCode: string;
    description: string;
    recipient: {
      legalName: string;
      gstin: string | null;
      pan: string | null;
      state: string;
      address: string;
      sacCode: string;
    };
  };
}

// ── Derived display shape ───────────────────────────────────────────────────────
interface InvoiceDisplay {
  id: string;
  invoiceNumber: string;
  invoiceNumberEdited: boolean;
  status: 'GENERATED' | 'PAID';
  invoiceKind: 'SERVICE' | 'TDS';
  period: string;
  periodLabel: string;
  invoiceDate: string;
  lockedAt: string | null;
  // Retailer (service provider)
  outletCode: string;
  outletName: string;
  firmName: string;
  partnerName: string;
  retailerState: string;
  panNumber: string | null;
  retailerGstin: string | null;
  // Recipient (Tech Gifsy)
  recipientName: string;
  recipientGstin: string | null;
  recipientPan: string | null;
  recipientState: string;
  recipientAddress: string;
  // Amounts (paise)
  subtotalPaise: number;
  gstPaise: number;
  gstType: 'CGST_SGST' | 'IGST' | null;
  totalPaise: number;
  // Meta
  sacCode: string;
  description: string;
}

function mapBackend(b: BackendInvoice): InvoiceDisplay {
  return {
    id:                  b.id,
    invoiceNumber:       b.invoiceNumber,
    invoiceNumberEdited: b.invoiceNumberEdited,
    status:              b.status,
    invoiceKind:         b.invoiceKind ?? 'SERVICE',
    period:              b.period,
    periodLabel:         formatPeriodLabel(b.period),
    invoiceDate:         b.invoiceDate,
    lockedAt:            b.lockedAt ?? null,
    outletCode:          b.snapshot.outletCode,
    outletName:          b.snapshot.outletName,
    firmName:            b.snapshot.firmName,
    partnerName:         b.snapshot.partnerName,
    retailerState:       b.snapshot.retailerState,
    panNumber:           b.snapshot.panNumber,
    retailerGstin:       b.snapshot.retailerGstin,
    recipientName:       b.snapshot.recipient.legalName,
    recipientGstin:      b.snapshot.recipient.gstin,
    recipientPan:        b.snapshot.recipient.pan,
    recipientState:      b.snapshot.recipient.state,
    recipientAddress:    b.snapshot.recipient.address,
    subtotalPaise:       b.subtotalPaise,
    gstPaise:            b.gstPaise,
    gstType:             b.gstType,
    totalPaise:          b.totalPaise,
    sacCode:             b.snapshot.sacCode,
    description:         b.snapshot.description,
  };
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// ── Page ────────────────────────────────────────────────────────────────────────
export default function AdminInvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const session = useAdminSession();
  const isGifsy = session.role === 'GIFSY_ADMIN';

  const [inv, setInv]               = useState<InvoiceDisplay | null>(null);
  const [loading, setLoading]       = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [markingPaid, setMarkingPaid]   = useState(false);
  const [markPaidError, setMarkPaidError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.get<BackendInvoice>(`/api/admin/invoices/${id}`)
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          setInv(mapBackend(res.data));
        } else {
          // api-client returns 'Network error' for a fetch failure (its catch); a server
          // failure carries the backend message (e.g. 'Invoice not found').
          setFetchError(res.error && res.error !== 'Network error' ? res.error : 'Failed to load invoice');
        }
      })
      .catch(() => { if (!cancelled) setFetchError('Failed to load invoice'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  const handleMarkPaid = async () => {
    if (!inv) return;
    setMarkingPaid(true);
    setMarkPaidError(null);
    const res = await api.patch<BackendInvoice>(`/api/admin/invoices/${inv.id}/mark-paid`, {});
    setMarkingPaid(false);
    if (res.success) {
      setInv(mapBackend(res.data));
    } else {
      setMarkPaidError(res.error ?? 'Failed to mark as paid');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    );
  }

  if (fetchError || !inv) {
    return (
      <div className="text-center py-20">
        <FileText className="w-8 h-8 text-gray-300 mx-auto mb-2" />
        <p className="text-gray-500 text-sm">{fetchError ?? 'Invoice not found'}</p>
        <Link href="/admin/invoices" className="text-[var(--brand-primary)] text-sm mt-3 inline-block">
          ← Back to invoices
        </Link>
      </div>
    );
  }

  // ── GST split helpers (backend guarantees an even CGST/SGST split) ──────────
  const cgstPaise = inv.gstType === 'CGST_SGST' ? Math.round(inv.gstPaise / 2) : 0;
  const sgstPaise = cgstPaise;
  const igstPaise = inv.gstType === 'IGST' ? inv.gstPaise : 0;
  const gstApplicable = inv.gstPaise > 0 && inv.gstType !== null;

  const canMarkPaid = isGifsy && inv.status === 'GENERATED';

  return (
    <div className="space-y-4 fade-in max-w-2xl">
      {/* Back + header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Link
            href="/admin/invoices"
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-base font-bold text-gray-900">Invoice Details</h1>
            <p className="text-[11px] text-gray-400 font-mono">{inv.invoiceNumber}</p>
          </div>
        </div>
        {canMarkPaid && (
          <button
            onClick={handleMarkPaid}
            disabled={markingPaid}
            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 transition-colors disabled:opacity-60"
          >
            {markingPaid
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <CheckCircle className="w-3.5 h-3.5" />}
            {markingPaid ? 'Marking…' : 'Mark Paid'}
          </button>
        )}
      </div>

      {/* Mark-paid error banner */}
      {markPaidError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {markPaidError}
        </div>
      )}

      {/* Status + dates */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-gray-500">Status</p>
          <span className={`inline-flex items-center gap-1 mt-1 text-xs font-medium px-2.5 py-1 rounded-full ${
            inv.status === 'PAID'
              ? 'bg-green-50 text-green-700'
              : 'bg-amber-50 text-amber-700'
          }`}>
            {inv.status === 'PAID'
              ? <CheckCircle className="w-3 h-3" />
              : <Clock className="w-3 h-3" />}
            {inv.status === 'PAID' ? 'Paid' : 'Generated'}
          </span>
          {inv.invoiceKind === 'TDS' && (
            <span className="inline-flex items-center ml-2 mt-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-purple-50 text-purple-700">
              TDS invoice
            </span>
          )}
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">Period</p>
          <p className="text-xs font-medium text-gray-800 mt-0.5">{inv.periodLabel}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">Invoice Date</p>
          <p className="text-xs font-medium text-gray-800 mt-0.5">{fmtDate(inv.invoiceDate)}</p>
        </div>
        {inv.status === 'PAID' && inv.lockedAt && (
          <div className="text-right">
            <p className="text-xs text-gray-500">Paid On</p>
            <p className="text-xs font-medium text-gray-800 mt-0.5">{fmtDate(inv.lockedAt)}</p>
          </div>
        )}
      </div>

      {/* Invoice details card */}
      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {/* From / To */}
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-2">Billed By (Service Provider)</p>
            <p className="text-xs font-semibold text-gray-800">{inv.firmName}</p>
            <p className="text-xs text-gray-600">{inv.partnerName}</p>
            <p className="text-[11px] text-gray-500 mt-1">
              Outlet <span className="font-mono">{inv.outletCode}</span>
              {inv.outletName ? ` · ${inv.outletName}` : ''}
            </p>
            <p className="text-xs text-gray-500 mt-1">{inv.retailerState}</p>
            {inv.panNumber && (
              <p className="text-[11px] font-mono text-gray-500 mt-1">PAN: {inv.panNumber}</p>
            )}
            {inv.retailerGstin && (
              <p className="text-[11px] font-mono text-gray-500">GSTIN: {inv.retailerGstin}</p>
            )}
          </div>
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-2">Billed To (Recipient)</p>
            <p className="text-xs font-semibold text-gray-800">{inv.recipientName}</p>
            {inv.recipientGstin && (
              <p className="text-[11px] font-mono text-gray-500 mt-1">GSTIN: {inv.recipientGstin}</p>
            )}
            {inv.recipientPan && (
              <p className="text-[11px] font-mono text-gray-500">PAN: {inv.recipientPan}</p>
            )}
            <p className="text-xs text-gray-500 mt-1">{inv.recipientState}</p>
            {inv.recipientAddress && (
              <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{inv.recipientAddress}</p>
            )}
          </div>
        </div>

        {/* Description + Period + SAC */}
        <div className="p-4 space-y-3">
          <div className="flex justify-between text-xs gap-4">
            <span className="text-gray-500">Description</span>
            <span className="font-medium text-gray-800 text-right">{inv.description}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Period</span>
            <span className="font-medium text-gray-800">{inv.periodLabel}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">SAC Code</span>
            <span className="font-mono text-gray-700">{inv.sacCode}</span>
          </div>
        </div>

        {/* Amount block */}
        <div className="p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-700 font-medium">Base Amount</span>
            <span className="font-bold text-gray-900">{formatINR(inv.subtotalPaise)}</span>
          </div>

          {gstApplicable && (
            <>
              {inv.gstType === 'CGST_SGST' ? (
                <>
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>CGST @ 9%</span>
                    <span>{formatINR(cgstPaise)}</span>
                  </div>
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>SGST @ 9%</span>
                    <span>{formatINR(sgstPaise)}</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between text-xs text-gray-500">
                  <span>IGST @ 18%</span>
                  <span>{formatINR(igstPaise)}</span>
                </div>
              )}
            </>
          )}

          <div className="flex justify-between text-sm border-t border-gray-100 pt-2 mt-2">
            <span className="font-semibold text-gray-800">Invoice Total</span>
            <span className="font-bold text-gray-900">{formatINR(inv.totalPaise)}</span>
          </div>
        </div>
      </div>

      {/* Self-billing note */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 flex gap-2">
        <FileText className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-gray-500 leading-relaxed">
          Auto-generated self-billing invoice for visibility payouts, raised by{' '}
          {inv.recipientName} on behalf of the service provider. No signature is required.
        </p>
      </div>
    </div>
  );
}
