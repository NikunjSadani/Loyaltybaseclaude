'use client';

import { useState, useEffect } from 'react';
import {
  CheckCircle,
  XCircle,
  RefreshCw,
  ZoomIn,
  X,
  ExternalLink,
  Clock,
  CheckSquare,
  AlertTriangle,
} from 'lucide-react';
import { KYC_REJECTION_REASONS, KYC_REJECTION_OTHER_OPTION } from '@/lib/kyc-rejection-reasons';

interface KYCDocument {
  id: string;
  type: string;
  label: string;
  url: string;
  status: 'pending' | 'verified' | 'rejected';
}

interface KYCReviewerProps {
  partnerId: string;
  partnerName: string;
  documents: KYCDocument[];
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => void;
  onRequestReupload: (id: string, reason: string) => void;
  /** Prisma document types the admin flagged for re-KYC (e.g. STORE_BOARD_PHOTO). Optional
   *  — when set, the matching document tab + checklist row are amber-highlighted so the
   *  Gifsy reviewer sees what was requested. Matched case-insensitively against doc.type. */
  flaggedDocTypes?: string[];
  /** Human labels of ALL flagged fields (incl. text-only fields with no document), for
   *  the top re-KYC banner. Optional. */
  flaggedLabels?: string[];
  /** The admin's free-text re-KYC remark, shown in the banner. Optional. */
  reKycRemarks?: string;
}

// Single source of truth shared with the sales senior-reject modal (the admin keeps
// its single-select behaviour; the same option set is preserved verbatim).
const REJECTION_REASONS = [...KYC_REJECTION_REASONS, KYC_REJECTION_OTHER_OPTION];

/** A document is a PDF (GST cert, shop-establishment, cancelled cheque, …) when its
 *  inlined data URL is application/pdf. PDFs cannot render in an <img> — they need an
 *  <iframe>/<embed> — which is why they previously showed a blank placeholder. */
function isPdfUrl(url: string): boolean {
  return url.startsWith('data:application/pdf') || url.toLowerCase().split(/[?#]/)[0].endsWith('.pdf');
}

/** Chrome blocks `data:` URLs both in <iframe> and as top-level navigations, so a PDF
 *  inlined as a data URL renders blank in an iframe AND won't open in a new tab.
 *  Convert any `data:` URL to a short-lived `blob:` URL (revoked on change) — blob URLs
 *  render in <iframe>, open in a new tab, and still work in <img>. Non-data URLs pass
 *  through unchanged. */
function useDisplayUrl(url?: string): string | undefined {
  const [blobUrl, setBlobUrl] = useState<string | undefined>();
  useEffect(() => {
    if (!url || !url.startsWith('data:')) { setBlobUrl(undefined); return; }
    try {
      const comma = url.indexOf(',');
      const mime = url.slice(5, url.indexOf(';'));
      const bin = atob(url.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const b = URL.createObjectURL(new Blob([bytes], { type: mime }));
      setBlobUrl(b);
      return () => URL.revokeObjectURL(b);
    } catch { setBlobUrl(undefined); }
  }, [url]);
  return url && url.startsWith('data:') ? blobUrl : url;
}

export function KYCReviewer({
  partnerId,
  partnerName,
  documents,
  onApprove,
  onReject,
  onRequestReupload,
  flaggedDocTypes,
  flaggedLabels,
  reKycRemarks,
}: KYCReviewerProps) {
  // doc.type is the lower-cased Prisma documentType (see admin/kyc/[id] mapping); the
  // flagged list carries Prisma types (e.g. STORE_BOARD_PHOTO) — compare case-insensitively.
  const flaggedSet = new Set((flaggedDocTypes ?? []).map((t) => t.toLowerCase()));
  const isDocFlagged = (doc: KYCDocument) => flaggedSet.has(doc.type.toLowerCase());
  const hasReKyc = (flaggedLabels?.length ?? 0) > 0 || flaggedSet.size > 0;
  const [selectedDoc, setSelectedDoc] = useState<KYCDocument | null>(documents[0] ?? null);
  const [zoomedDoc, setZoomedDoc] = useState<KYCDocument | null>(null);
  const [actionModal, setActionModal] = useState<'reject' | 'reupload' | null>(null);
  const [selectedReason, setSelectedReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [approveConfirm, setApproveConfirm] = useState(false);

  // PDF docs need an <iframe>; and `data:` URLs must become `blob:` URLs to render in
  // an iframe / open in a new tab (see useDisplayUrl). Photos (JPEG/PNG) keep <img>.
  const selectedUrl = useDisplayUrl(selectedDoc?.url);
  const zoomedUrl = useDisplayUrl(zoomedDoc?.url);
  const selectedIsPdf = !!selectedDoc && isPdfUrl(selectedDoc.url);
  const zoomedIsPdf = !!zoomedDoc && isPdfUrl(zoomedDoc.url);

  const finalReason = selectedReason === 'Other (specify below)' ? customReason : selectedReason;

  const handleApprove = () => {
    if (approveConfirm) {
      onApprove(partnerId);
      setApproveConfirm(false);
    } else {
      setApproveConfirm(true);
    }
  };

  const handleReject = () => {
    if (!finalReason) return;
    onReject(partnerId, finalReason);
    setActionModal(null);
    setSelectedReason('');
    setCustomReason('');
  };

  const handleReupload = () => {
    if (!finalReason) return;
    onRequestReupload(partnerId, finalReason);
    setActionModal(null);
    setSelectedReason('');
    setCustomReason('');
  };

  const docStatusIcon = (status: KYCDocument['status']) => {
    if (status === 'verified') return <CheckCircle className="w-4 h-4 text-green-500" />;
    if (status === 'rejected') return <XCircle className="w-4 h-4 text-red-500" />;
    return <Clock className="w-4 h-4 text-amber-500" />;
  };

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Re-KYC requested — admin flagged specific fields for re-capture. Lists the flagged
          labels (incl. text-only fields) + remark; the matching doc tabs/checklist rows below
          are amber-highlighted. Rendered only when flags were passed in. */}
      {hasReKyc && (
        <div
          data-testid="rekyc-reviewer-banner"
          className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2"
        >
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-800">Re-KYC requested</p>
            {(flaggedLabels?.length ?? 0) > 0 && (
              <p className="text-xs text-amber-700 mt-0.5">
                Flagged for re-capture: <span className="font-medium">{flaggedLabels!.join(', ')}</span>
              </p>
            )}
            {reKycRemarks && <p className="text-xs text-amber-700 mt-1 italic">{reKycRemarks}</p>}
          </div>
        </div>
      )}

    <div className="flex gap-4 h-full">
      {/* Left: Document list + viewer */}
      <div className="flex-1 flex flex-col gap-3">
        {/* Document tabs */}
        <div className="flex flex-wrap gap-2">
          {documents.map((doc) => {
            const flagged = isDocFlagged(doc);
            return (
            <button
              key={doc.id}
              onClick={() => setSelectedDoc(doc)}
              data-testid={flagged ? 'rekyc-flagged-doc-tab' : undefined}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                selectedDoc?.id === doc.id
                  ? 'border-[var(--brand-primary)] bg-red-50 text-[var(--brand-primary)]'
                  : flagged
                    ? 'border-amber-300 bg-amber-50 text-amber-800'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
              }`}
            >
              {docStatusIcon(doc.status)}
              {doc.label}
              {flagged && <span className="text-[10px] font-semibold text-amber-700">Re-KYC</span>}
            </button>
            );
          })}
        </div>

        {/* Document viewer.
            Signatures are transparent-background PNGs with near-black strokes — on a
            dark container they're invisible, so render them on a light/white background.
            Opaque photo docs keep the dark backdrop. */}
        {selectedDoc && (
          <div className={`relative flex-1 rounded-xl overflow-hidden min-h-[400px] flex items-center justify-center ${
            selectedDoc.type === 'signature' ? 'bg-white' : 'bg-gray-900'
          }`}>
            {selectedIsPdf ? (
              selectedUrl ? (
                <iframe
                  src={selectedUrl}
                  title={selectedDoc.label}
                  className="w-full h-[400px] bg-white"
                />
              ) : (
                <div className="flex items-center gap-2 text-white text-xs">
                  <RefreshCw className="w-4 h-4 animate-spin" /> Loading document…
                </div>
              )
            ) : (
              <img
                src={selectedUrl ?? selectedDoc.url}
                alt={selectedDoc.label}
                className="max-w-full max-h-[400px] object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = `https://placehold.co/600x400/1a1a2e/ffffff?text=${encodeURIComponent(selectedDoc.label)}`;
                }}
              />
            )}
            <div className="absolute top-3 right-3 flex gap-2">
              {!selectedIsPdf && (
                <button
                  onClick={() => setZoomedDoc(selectedDoc)}
                  className="p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors"
                  title="Zoom in"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
              )}
              <a
                href={selectedUrl ?? selectedDoc.url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors"
                title="Open in new tab"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
            <div className="absolute bottom-3 left-3 bg-black/50 rounded-lg px-3 py-1.5">
              <p className="text-white text-xs font-medium">{selectedDoc.label}</p>
              <p className="text-gray-300 text-xs capitalize">{selectedDoc.type}</p>
            </div>
          </div>
        )}
      </div>

      {/* Right: Approval panel */}
      <div className="w-60 flex flex-col gap-3 flex-shrink-0">
        <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Document Checklist
          </h3>
          <div className="space-y-2">
            {documents.map((doc) => {
              const flagged = isDocFlagged(doc);
              return (
              <div
                key={doc.id}
                data-testid={flagged ? 'rekyc-flagged-checklist-row' : undefined}
                className={`flex items-center gap-2 ${flagged ? 'bg-amber-50 -mx-1 px-1 py-0.5 rounded' : ''}`}
              >
                {docStatusIcon(doc.status)}
                <span className={`text-xs flex-1 ${flagged ? 'text-amber-800 font-medium' : 'text-gray-700'}`}>{doc.label}</span>
                {flagged ? (
                  <span className="text-xs text-amber-700 font-semibold">Re-KYC</span>
                ) : doc.status === 'pending' && (
                  <span className="text-xs text-amber-600 font-medium">Review</span>
                )}
              </div>
              );
            })}
          </div>
        </div>

        <div className="bg-white rounded-xl p-4 border border-gray-200 flex-1">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
            Decision
          </h3>
          <div className="space-y-2">
            <button
              onClick={handleApprove}
              className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                approveConfirm
                  ? 'bg-green-600 text-white hover:bg-green-700'
                  : 'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100'
              }`}
            >
              <CheckSquare className="w-4 h-4" />
              {approveConfirm ? 'Confirm Approve' : 'Approve KYC'}
            </button>

            {approveConfirm && (
              <button
                onClick={() => setApproveConfirm(false)}
                className="w-full py-2 rounded-lg text-xs text-gray-500 hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
            )}

            <button
              onClick={() => { setActionModal('reupload'); setApproveConfirm(false); }}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-all"
            >
              <RefreshCw className="w-4 h-4" />
              Request Re-upload
            </button>

            <button
              onClick={() => { setActionModal('reject'); setApproveConfirm(false); }}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 transition-all"
            >
              <XCircle className="w-4 h-4" />
              Reject KYC
            </button>
          </div>
        </div>

        <div className="bg-amber-50 rounded-xl p-3 border border-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-amber-700">
              All actions are logged with your user ID and timestamp and cannot be undone.
            </p>
          </div>
        </div>
      </div>
    </div>

      {/* Zoom modal */}
      {zoomedDoc && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="relative max-w-4xl w-full">
            <button
              onClick={() => setZoomedDoc(null)}
              className="absolute -top-10 right-0 text-white hover:text-gray-300 transition-colors"
            >
              <X className="w-6 h-6" />
            </button>
            {zoomedIsPdf ? (
              <iframe
                src={zoomedUrl}
                title={zoomedDoc.label}
                className="w-full h-[80vh] rounded-xl bg-white"
              />
            ) : (
              <img
                src={zoomedUrl ?? zoomedDoc.url}
                alt={zoomedDoc.label}
                // Signatures are transparent PNGs → a white backing makes the strokes visible
                // against the dark modal overlay. Photo docs are opaque so it's a no-op for them.
                className={`w-full rounded-xl ${zoomedDoc.type === 'signature' ? 'bg-white' : ''}`}
                onError={(e) => {
                  (e.target as HTMLImageElement).src = `https://placehold.co/800x600/1a1a2e/ffffff?text=${encodeURIComponent(zoomedDoc.label)}`;
                }}
              />
            )}
            <p className="text-white text-center mt-3 text-sm">{zoomedDoc.label}</p>
          </div>
        </div>
      )}

      {/* Action modal */}
      {actionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-gray-900">
                {actionModal === 'reject' ? 'Reject KYC' : 'Request Re-upload'}
              </h2>
              <button
                onClick={() => { setActionModal(null); setSelectedReason(''); setCustomReason(''); }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-4">
              Partner: <span className="font-semibold text-gray-800">{partnerName}</span>
            </p>

            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-700 mb-2">
                Select Reason <span className="text-red-500">*</span>
              </label>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {REJECTION_REASONS.map((reason) => (
                  <label key={reason} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="reason"
                      value={reason}
                      checked={selectedReason === reason}
                      onChange={() => setSelectedReason(reason)}
                      className="accent-[var(--brand-primary)]"
                    />
                    <span className="text-xs text-gray-700">{reason}</span>
                  </label>
                ))}
              </div>
            </div>

            {selectedReason === 'Other (specify below)' && (
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Custom Reason <span className="text-red-500">*</span>
                </label>
                <textarea
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                  rows={3}
                  placeholder="Describe the issue in detail..."
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)] resize-none"
                />
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => { setActionModal(null); setSelectedReason(''); setCustomReason(''); }}
                className="flex-1 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={actionModal === 'reject' ? handleReject : handleReupload}
                disabled={!finalReason}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium text-white transition-colors ${
                  actionModal === 'reject'
                    ? 'bg-red-600 hover:bg-red-700 disabled:bg-red-300'
                    : 'bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300'
                }`}
              >
                {actionModal === 'reject' ? 'Confirm Reject' : 'Send Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
