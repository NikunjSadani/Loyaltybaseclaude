'use client';

/**
 * /partner/invoices/[id]
 * Invoice detail view for the retailer.
 *
 * - Shows gross amount only (no TDS, no 194C)
 * - Invoice number editable while status = GENERATED
 * - PDF download via jsPDF
 */

import { useState, use } from 'react';
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
import { MOCK_VISIBILITY_INVOICES, type VisibilityInvoice } from '@/lib/invoice';

// ── Props ─────────────────────────────────────────────────────────────────────
export default function PartnerInvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const original = MOCK_VISIBILITY_INVOICES.find((inv) => inv.id === id);

  // Local state — in a real app this would hit an API
  const [inv, setInv] = useState<VisibilityInvoice | undefined>(original);
  const [editingNumber, setEditingNumber] = useState(false);
  const [draftNumber, setDraftNumber] = useState(original?.invoiceNumber ?? '');
  const [numberError, setNumberError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [downloading, setDownloading] = useState(false);

  if (!inv) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500 text-sm">Invoice not found</p>
        <Link href="/partner/invoices" className="text-[var(--brand-primary)] text-sm mt-2 inline-block">
          ← Back to invoices
        </Link>
      </div>
    );
  }

  const canEditNumber = inv.status === 'GENERATED';

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
      const res = await fetch(`/api/partner/invoices/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceNumber: trimmed }),
      });

      const data = await res.json();

      if (!res.ok) {
        setNumberError(data.error ?? 'Failed to save. Please try again.');
        return;
      }

      // Update local state from server response
      setInv((prev) =>
        prev
          ? { ...prev, invoiceNumber: data.invoiceNumber, invoiceNumberEdited: true }
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
      generateVisibilityInvoicePDF(inv);
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
          <p className="text-xs text-gray-500">Generated on</p>
          <p className="text-xs font-medium text-gray-800 mt-0.5">
            {new Date(inv.generatedAt).toLocaleDateString('en-IN', {
              day: 'numeric', month: 'short', year: 'numeric',
            })}
          </p>
        </div>
        {inv.paidAt && (
          <div className="text-right">
            <p className="text-xs text-gray-500">Paid on</p>
            <p className="text-xs font-medium text-gray-800 mt-0.5">
              {new Date(inv.paidAt).toLocaleDateString('en-IN', {
                day: 'numeric', month: 'short', year: 'numeric',
              })}
            </p>
          </div>
        )}
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
            {inv.gstNumber && (
              <p className="text-[11px] font-mono text-gray-500">GSTIN: {inv.gstNumber}</p>
            )}
          </div>
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-2">Billed To</p>
            <p className="text-xs font-semibold text-gray-800">Tech Gifsy Solutions Limited</p>
            <p className="text-xs text-gray-500 mt-1">West Bengal, India</p>
          </div>
        </div>

        {/* Description + Period */}
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
          {/* Base amount — always shown */}
          <div className="flex justify-between text-sm">
            <span className="text-gray-700 font-medium">Amount</span>
            <span className="font-bold text-gray-900">₹{inv.baseAmount.toLocaleString('en-IN')}</span>
          </div>

          {/* GST — only for REGULAR retailers */}
          {inv.gstApplicable && (
            <>
              {inv.gstType === 'CGST_SGST' ? (
                <>
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>CGST @ 9%</span>
                    <span>₹{inv.cgst.toLocaleString('en-IN')}</span>
                  </div>
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>SGST @ 9%</span>
                    <span>₹{inv.sgst.toLocaleString('en-IN')}</span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between text-xs text-gray-500">
                  <span>IGST @ 18%</span>
                  <span>₹{inv.igst.toLocaleString('en-IN')}</span>
                </div>
              )}
              <div className="flex justify-between text-sm border-t border-gray-100 pt-2 mt-2">
                <span className="font-semibold text-gray-800">Invoice Total</span>
                <span className="font-bold text-gray-900">₹{inv.totalInvoiceAmount.toLocaleString('en-IN')}</span>
              </div>
            </>
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
