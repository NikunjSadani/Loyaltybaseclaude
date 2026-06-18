'use client';

/**
 * /partner/invoices/[id]
 * Invoice detail view for the retailer.
 *
 * - Shows gross amount only (no TDS, no 194C)
 * - Invoice number editable while status = GENERATED
 * - PDF download via jsPDF
 *
 * Backend:
 *   GET   /api/partner/invoices/:id
 *   PATCH /api/partner/invoices/:id/invoice-number  body { invoiceNumber }
 *
 * Money: all paise fields — divide by 100 for ₹ display.
 * CGST_SGST split: CGST = SGST = gstPaise / 2.
 */

import { useState, useEffect, use } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  Download,
  Edit2,
  Check,
  X,
  AlertCircle,
  CheckCircle,
  Clock,
  FileText,
  Loader2,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { api, authHeader } from '@/lib/api-client';
import { formatINR, paiseToRupees } from '@/lib/money';
import { formatPeriodLabel } from '@/lib/invoice';

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
    mobile: string;
    retailerState: string;
    retailerGstin: string | null;
    panNumber: string | null;
    entityType: string;
    gstRegistrationType: string;
    bankName: string;
    accountNumber: string;
    ifscCode: string;
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

// ── Derived display shape ─────────────────────────────────────────────────────
interface InvoiceDisplay {
  id: string;
  invoiceNumber: string;
  invoiceNumberEdited: boolean;
  status: 'GENERATED' | 'PAID';
  period: string;
  periodLabel: string;
  invoiceDate: string;
  // Retailer (service provider)
  outletCode: string;
  firmName: string;
  partnerName: string;
  retailerState: string;
  panNumber: string | null;
  retailerGstin: string | null;
  // Recipient (Tech Gifsy)
  recipientName: string;
  recipientGstin: string | null;
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
    id:                   b.id,
    invoiceNumber:        b.invoiceNumber,
    invoiceNumberEdited:  b.invoiceNumberEdited,
    status:               b.status,
    period:               b.period,
    periodLabel:          formatPeriodLabel(b.period),
    invoiceDate:          b.invoiceDate,
    outletCode:           b.snapshot.outletCode,
    firmName:             b.snapshot.firmName,
    partnerName:          b.snapshot.partnerName,
    retailerState:        b.snapshot.retailerState,
    panNumber:            b.snapshot.panNumber,
    retailerGstin:        b.snapshot.retailerGstin,
    recipientName:        b.snapshot.recipient.legalName,
    recipientGstin:       b.snapshot.recipient.gstin,
    recipientState:       b.snapshot.recipient.state,
    recipientAddress:     b.snapshot.recipient.address,
    subtotalPaise:        b.subtotalPaise,
    gstPaise:             b.gstPaise,
    gstType:              b.gstType,
    totalPaise:           b.totalPaise,
    sacCode:              b.snapshot.sacCode,
    description:          b.snapshot.description,
  };
}

// ── Props ─────────────────────────────────────────────────────────────────────
export default function PartnerInvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [inv, setInv]                   = useState<InvoiceDisplay | null>(null);
  const [loading, setLoading]           = useState(true);
  const [fetchError, setFetchError]     = useState<string | null>(null);
  const [editingNumber, setEditingNumber] = useState(false);
  const [draftNumber, setDraftNumber]   = useState('');
  const [numberError, setNumberError]   = useState<string | null>(null);
  const [saving, setSaving]             = useState(false);
  const [saveSuccess, setSaveSuccess]   = useState(false);
  const [downloading, setDownloading]   = useState(false);

  useEffect(() => {
    if (!id) return;
    api.get<BackendInvoice>(`/api/partner/invoices/${id}`)
      .then((res) => {
        if (res.success) {
          const mapped = mapBackend(res.data);
          setInv(mapped);
          setDraftNumber(mapped.invoiceNumber);
        } else {
          // api-client returns 'Network error' for a fetch/network failure (its catch);
          // a server failure carries the backend's message (e.g. 'Invoice not found').
          setFetchError(res.error && res.error !== 'Network error' ? res.error : 'Failed to load invoice');
        }
      })
      .catch(() => setFetchError('Failed to load invoice'))
      .finally(() => setLoading(false));
  }, [id]);

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
        <p className="text-gray-500 text-sm">{fetchError ?? 'Invoice not found'}</p>
        <Link href="/partner/invoices" className="text-[var(--brand-primary)] text-sm mt-2 inline-block">
          ← Back to invoices
        </Link>
      </div>
    );
  }

  const canEditNumber = inv.status === 'GENERATED';

  // ── GST split helpers ─────────────────────────────────────────────────────
  // For CGST_SGST: each leg = gstPaise / 2 (backend guarantees even split)
  const cgstPaise = inv.gstType === 'CGST_SGST' ? Math.round(inv.gstPaise / 2) : 0;
  const sgstPaise = cgstPaise;
  const igstPaise = inv.gstType === 'IGST' ? inv.gstPaise : 0;
  const gstApplicable = inv.gstPaise > 0 && inv.gstType !== null;

  // ── Invoice number editing ────────────────────────────────────────────────
  const startEdit = () => {
    setDraftNumber(inv.invoiceNumber);
    setNumberError(null);
    setEditingNumber(true);
  };

  const cancelEdit = () => {
    setEditingNumber(false);
    setNumberError(null);
  };

  const saveNumber = async () => {
    const trimmed = draftNumber.trim().toUpperCase();

    // Client-side validation (mirrors server rules)
    if (!trimmed) {
      setNumberError('Invoice number cannot be empty.');
      return;
    }
    if (!/^[A-Z0-9\-\/]+$/i.test(trimmed)) {
      setNumberError('Only letters, numbers, hyphens, and slashes are allowed.');
      return;
    }
    if (trimmed.length > 60) {
      setNumberError('Invoice number must be 60 characters or fewer.');
      return;
    }

    setSaving(true);
    setNumberError(null);

    try {
      const res = await fetch(`/api/partner/invoices/${id}/invoice-number`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(),
        },
        body: JSON.stringify({ invoiceNumber: trimmed }),
      });

      const data = await res.json();

      if (!res.ok) {
        setNumberError(data.error ?? 'Failed to save. Please try again.');
        return;
      }

      // Update local state from server response
      const updated: BackendInvoice = data.success ? data.data : data;
      setInv((prev) =>
        prev
          ? {
              ...prev,
              invoiceNumber:       updated.invoiceNumber ?? trimmed,
              invoiceNumberEdited: true,
            }
          : prev,
      );
      setEditingNumber(false);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      setNumberError('Network error — please check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── PDF download ──────────────────────────────────────────────────────────
  const handleDownload = async () => {
    setDownloading(true);
    try {
      const { generateVisibilityInvoicePDF } = await import(
        '@/components/invoice/VisibilityInvoicePDF'
      );
      // Build a VisibilityInvoice-compatible shape for the existing PDF generator
      generateVisibilityInvoicePDF({
        id:                   inv.id,
        invoiceNumber:        inv.invoiceNumber,
        invoiceNumberEdited:  inv.invoiceNumberEdited,
        status:               inv.status,
        period:               inv.period,
        periodLabel:          inv.periodLabel,
        outletId:             '',
        outletCode:           inv.outletCode,
        outletName:           inv.firmName,
        firmName:             inv.firmName,
        partnerName:          inv.partnerName,
        mobile:               '',
        retailerState:        inv.retailerState,
        panNumber:            inv.panNumber,
        gstNumber:            inv.retailerGstin,
        entityType:           'INDIVIDUAL',
        gstRegistrationType:  inv.gstType ? 'REGULAR' : 'UNREGISTERED',
        bankName:             '',
        accountNumber:        '',
        ifscCode:             '',
        baseAmount:           paiseToRupees(inv.subtotalPaise),
        gstApplicable,
        gstType:              inv.gstType,
        cgst:                 paiseToRupees(cgstPaise),
        sgst:                 paiseToRupees(sgstPaise),
        igst:                 paiseToRupees(igstPaise),
        totalGST:             paiseToRupees(inv.gstPaise),
        totalInvoiceAmount:   paiseToRupees(inv.totalPaise),
        tdsRate:              0,
        tdsAmount:            0,
        netDisbursed:         paiseToRupees(inv.subtotalPaise),
        generatedAt:          inv.invoiceDate,
        paidAt:               null,
        uploadBatchId:        '',
        sacCode:              '998361',
        description:          inv.description,
      } as Parameters<typeof generateVisibilityInvoicePDF>[0]);
    } catch (err) {
      console.error('PDF generation failed', err);
    } finally {
      setDownloading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 fade-in max-w-2xl">
      {/* Back + header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link
            href="/partner/invoices"
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-base font-bold text-gray-900">Invoice Details</h1>
            <p className="text-[11px] text-gray-400 font-mono">{inv.invoiceNumber}</p>
          </div>
        </div>
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-green-700 transition-colors disabled:opacity-60"
        >
          <Download className="w-3.5 h-3.5" />
          {downloading ? 'Generating…' : 'Download PDF'}
        </button>
      </div>

      {/* Status + dates */}
      <div className="bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500">Status</p>
          <span className={`inline-flex items-center gap-1 mt-1 text-xs font-medium px-2.5 py-1 rounded-full ${
            inv.status === 'PAID'
              ? 'bg-green-50 text-green-700'
              : 'bg-amber-50 text-amber-700'
          }`}>
            {inv.status === 'PAID'
              ? <CheckCircle className="w-3 h-3" />
              : <Clock className="w-3 h-3" />
            }
            {inv.status === 'PAID' ? 'Paid' : 'Processing'}
          </span>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">Period</p>
          <p className="text-xs font-medium text-gray-800 mt-0.5">{inv.periodLabel}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-500">Invoice Date</p>
          <p className="text-xs font-medium text-gray-800 mt-0.5">
            {new Date(inv.invoiceDate).toLocaleDateString('en-IN', {
              day: 'numeric', month: 'short', year: 'numeric',
            })}
          </p>
        </div>
      </div>

      {/* Invoice number (editable) */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold text-gray-700">Invoice Number</p>
          {canEditNumber && !editingNumber && (
            <button
              onClick={startEdit}
              className="text-[11px] text-[var(--brand-primary)] flex items-center gap-1 hover:underline"
            >
              <Edit2 className="w-3 h-3" /> Edit
            </button>
          )}
          {!canEditNumber && (
            <span className="text-[10px] text-gray-400 bg-gray-50 px-2 py-0.5 rounded-full">
              Locked after payment
            </span>
          )}
        </div>

        {editingNumber ? (
          <div className="space-y-2">
            <input
              type="text"
              value={draftNumber}
              onChange={(e) => setDraftNumber(e.target.value.toUpperCase())}
              className="w-full font-mono text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30 focus:border-[var(--brand-primary)] uppercase"
              autoFocus
            />
            {numberError && (
              <p className="text-xs text-red-500 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {numberError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={saveNumber}
                disabled={saving}
                className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-[var(--brand-primary)] text-white font-semibold hover:bg-green-700 transition-colors disabled:opacity-60"
              >
                {saving
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Check className="w-3 h-3" />
                }
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={cancelEdit}
                disabled={saving}
                className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40"
              >
                <X className="w-3 h-3" /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <p className="font-mono text-sm text-gray-800">{inv.invoiceNumber}</p>
            {inv.invoiceNumberEdited && (
              <span className="text-[10px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">
                Edited
              </span>
            )}
          </div>
        )}
      </div>

      {/* Save success toast */}
      {saveSuccess && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-xs text-green-700">
          <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
          Invoice number updated successfully.
        </div>
      )}

      {/* Invoice details card */}
      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {/* From / To */}
        <div className="p-4 grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-2">Billed By (Service Provider)</p>
            <p className="text-xs font-semibold text-gray-800">{inv.firmName}</p>
            <p className="text-xs text-gray-600">{inv.partnerName}</p>
            <p className="text-xs text-gray-500 mt-1">{inv.retailerState}</p>
            {inv.panNumber && (
              <p className="text-[11px] font-mono text-gray-500 mt-1">PAN: {inv.panNumber}</p>
            )}
            {inv.retailerGstin && (
              <p className="text-[11px] font-mono text-gray-500">GSTIN: {inv.retailerGstin}</p>
            )}
          </div>
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-2">Billed To</p>
            <p className="text-xs font-semibold text-gray-800">{inv.recipientName}</p>
            {inv.recipientGstin && (
              <p className="text-[11px] font-mono text-gray-500 mt-1">GSTIN: {inv.recipientGstin}</p>
            )}
            <p className="text-xs text-gray-500 mt-1">{inv.recipientState}</p>
            {inv.recipientAddress && (
              <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{inv.recipientAddress}</p>
            )}
          </div>
        </div>

        {/* Description + Period + SAC */}
        <div className="p-4 space-y-3">
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Period</span>
            <span className="font-medium text-gray-800">{inv.periodLabel}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">Description</span>
            <span className="font-medium text-gray-800 text-right max-w-xs">{inv.description}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-gray-500">SAC Code</span>
            <span className="font-mono text-gray-700">{inv.sacCode}</span>
          </div>
        </div>

        {/* Amount block */}
        <div className="p-4 space-y-2">
          {/* Subtotal — always shown */}
          <div className="flex justify-between text-sm">
            <span className="text-gray-700 font-medium">Amount</span>
            <span className="font-bold text-gray-900">{formatINR(inv.subtotalPaise)}</span>
          </div>

          {/* GST — only when applicable */}
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
              <div className="flex justify-between text-sm border-t border-gray-100 pt-2 mt-2">
                <span className="font-semibold text-gray-800">Invoice Total</span>
                <span className="font-bold text-gray-900">{formatINR(inv.totalPaise)}</span>
              </div>
            </>
          )}

          {/* When no GST, still show a total line for clarity */}
          {!gstApplicable && (
            <div className="flex justify-between text-sm border-t border-gray-100 pt-2 mt-2">
              <span className="font-semibold text-gray-800">Invoice Total</span>
              <span className="font-bold text-gray-900">{formatINR(inv.totalPaise)}</span>
            </div>
          )}
        </div>
      </div>

      {/* Disclaimer */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 flex gap-2">
        <FileText className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-gray-500 leading-relaxed">
          This is an automated invoice generated by Tech Gifsy Solutions Limited on behalf
          of the service provider named above, under a mutually agreed self-billing
          arrangement. No signature is required on this invoice.
        </p>
      </div>
    </div>
  );
}
