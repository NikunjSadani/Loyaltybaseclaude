'use client';

import { useState } from 'react';
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
}

const REJECTION_REASONS = [
  'Document image is blurry or unreadable',
  'Document is expired',
  'Name mismatch between documents',
  'GST number does not match PAN',
  'Bank account details mismatch',
  'Address proof does not match registered address',
  'Photo ID is incomplete or damaged',
  'Signed agreement is missing',
  'Other (specify below)',
];

export function KYCReviewer({
  partnerId,
  partnerName,
  documents,
  onApprove,
  onReject,
  onRequestReupload,
}: KYCReviewerProps) {
  const [selectedDoc, setSelectedDoc] = useState<KYCDocument | null>(documents[0] ?? null);
  const [zoomedDoc, setZoomedDoc] = useState<KYCDocument | null>(null);
  const [actionModal, setActionModal] = useState<'reject' | 'reupload' | null>(null);
  const [selectedReason, setSelectedReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [approveConfirm, setApproveConfirm] = useState(false);

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
    <div className="flex gap-4 h-full">
      {/* Left: Document list + viewer */}
      <div className="flex-1 flex flex-col gap-3">
        {/* Document tabs */}
        <div className="flex flex-wrap gap-2">
          {documents.map((doc) => (
            <button
              key={doc.id}
              onClick={() => setSelectedDoc(doc)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                selectedDoc?.id === doc.id
                  ? 'border-[var(--brand-primary)] bg-red-50 text-[var(--brand-primary)]'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
              }`}
            >
              {docStatusIcon(doc.status)}
              {doc.label}
            </button>
          ))}
        </div>

        {/* Document viewer */}
        {selectedDoc && (
          <div className="relative flex-1 bg-gray-900 rounded-xl overflow-hidden min-h-[400px] flex items-center justify-center">
            <img
              src={selectedDoc.url}
              alt={selectedDoc.label}
              className="max-w-full max-h-[400px] object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).src = `https://placehold.co/600x400/1a1a2e/ffffff?text=${encodeURIComponent(selectedDoc.label)}`;
              }}
            />
            <div className="absolute top-3 right-3 flex gap-2">
              <button
                onClick={() => setZoomedDoc(selectedDoc)}
                className="p-2 bg-white/10 hover:bg-white/20 rounded-lg text-white transition-colors"
                title="Zoom in"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              <a
                href={selectedDoc.url}
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
            {documents.map((doc) => (
              <div key={doc.id} className="flex items-center gap-2">
                {docStatusIcon(doc.status)}
                <span className="text-xs text-gray-700 flex-1">{doc.label}</span>
                {doc.status === 'pending' && (
                  <span className="text-xs text-amber-600 font-medium">Review</span>
                )}
              </div>
            ))}
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
            <img
              src={zoomedDoc.url}
              alt={zoomedDoc.label}
              className="w-full rounded-xl"
              onError={(e) => {
                (e.target as HTMLImageElement).src = `https://placehold.co/800x600/1a1a2e/ffffff?text=${encodeURIComponent(zoomedDoc.label)}`;
              }}
            />
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
