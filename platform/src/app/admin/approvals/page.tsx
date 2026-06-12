'use client';

import React, { useState } from 'react';
import {
  CheckCircle, XCircle, Clock, Building2, User,
  Phone, FileCheck, AlertTriangle, ChevronDown, ChevronUp,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KYCStatus, type ApprovalEvent, type KYCSubmitterRole } from '@/types';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

interface PendingKYC {
  id:              string;
  firmName:        string;
  partnerName:     string;
  mobile:          string;
  city:            string;
  partnerClass:    string;
  submittedAt:     string;
  submittedByRole: KYCSubmitterRole;
  submittedByName: string;
  firstApprovedBy: string;
  firstApprovedAt: string;
  documents:       { label: string; status: 'uploaded' | 'verified' | 'missing' }[];
}

/* ─── Mock data — these are entries in PENDING_GIFSY state ──────────────────── */

const MOCK_PENDING: PendingKYC[] = [
  {
    id: 'k5', firmName: 'Mehta Provisions', partnerName: 'Vijay Mehta',
    mobile: '9432109876', city: 'Mumbai', partnerClass: 'SILVER',
    submittedAt: '2026-05-14', submittedByRole: 'SO', submittedByName: 'Rajesh Kumar',
    firstApprovedBy: 'Sanjay Kapoor (ASM)', firstApprovedAt: '2026-05-15',
    documents: [
      { label: 'GST Certificate', status: 'uploaded' }, { label: 'PAN Card', status: 'uploaded' },
      { label: 'Shop Photo',      status: 'uploaded' }, { label: 'Cancelled Cheque', status: 'uploaded' },
    ],
  },
  {
    id: 'k9', firmName: 'Desai Mart', partnerName: 'Ramesh Desai',
    mobile: '9123456789', city: 'Pune', partnerClass: 'GOLD',
    submittedAt: '2026-05-20', submittedByRole: 'XSR', submittedByName: 'Deepak Pillai',
    firstApprovedBy: 'Rajesh Kumar (SO)', firstApprovedAt: '2026-05-21',
    documents: [
      { label: 'GST Certificate', status: 'verified' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Shop Photo',      status: 'uploaded' }, { label: 'Cancelled Cheque', status: 'verified' },
    ],
  },
  {
    id: 'k10', firmName: 'Nair Provisions', partnerName: 'Suresh Nair',
    mobile: '9988776655', city: 'Nagpur', partnerClass: 'BRONZE',
    submittedAt: '2026-05-22', submittedByRole: 'SO', submittedByName: 'Anita Patel',
    firstApprovedBy: 'Ravi Mehta (ASM)', firstApprovedAt: '2026-05-23',
    documents: [
      { label: 'GST Certificate', status: 'uploaded' }, { label: 'PAN Card', status: 'uploaded' },
      { label: 'Shop Photo',      status: 'uploaded' }, { label: 'Cancelled Cheque', status: 'uploaded' },
    ],
  },
];

const docStatusColor: Record<string, string> = {
  verified: 'text-emerald-600',
  uploaded: 'text-blue-600',
  missing:  'text-red-500',
};

/* ─── Rejection modal ────────────────────────────────────────────────────────── */

function RejectionModal({ onConfirm, onCancel }: { onConfirm: (r: string) => void; onCancel: () => void }) {
  const [remarks, setRemarks] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl p-6 w-full max-w-md shadow-xl space-y-4">
        <h3 className="text-base font-bold text-gray-900">Rejection Remarks</h3>
        <p className="text-sm text-gray-500">Provide a reason. This will be visible to the SO/ASM and the original submitter.</p>
        <textarea
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="e.g. GST certificate could not be verified against GSTIN portal — mismatch found."
          rows={4}
          className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-red-300 focus:border-red-400 resize-none"
        />
        <div className="flex gap-3">
          <Button variant="outline" className="flex-1" onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            className="flex-1 !bg-red-600 hover:!bg-red-700"
            disabled={!remarks.trim()}
            onClick={() => remarks.trim() && onConfirm(remarks.trim())}
          >
            Confirm Rejection
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ─── KYC Entry card ─────────────────────────────────────────────────────────── */

function KYCApprovalCard({
  entry,
  onApprove,
  onReject,
}: {
  entry:     PendingKYC;
  onApprove: (id: string) => void;
  onReject:  (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="border-amber-200">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="text-sm font-bold text-gray-900 truncate">{entry.firmName}</p>
              <Badge variant="warning">{entry.partnerClass}</Badge>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">{entry.partnerName} · {entry.mobile} · {entry.city}</p>
          </div>
          <Badge variant="info">Awaiting Gifsy</Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        {/* Approval trail */}
        <div className="bg-gray-50 rounded-xl p-3 space-y-1.5 text-xs">
          <div className="flex items-center gap-2 text-gray-600">
            <FileCheck className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            <span>Submitted by <strong>{entry.submittedByName}</strong> ({entry.submittedByRole}) on {new Date(entry.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
          </div>
          <div className="flex items-center gap-2 text-gray-600">
            <CheckCircle className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
            <span>Approved by <strong>{entry.firstApprovedBy}</strong> on {new Date(entry.firstApprovedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
          </div>
        </div>

        {/* Document toggle */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-xs font-medium text-[var(--brand-primary)] hover:underline"
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {expanded ? 'Hide documents' : 'View documents'}
        </button>

        {expanded && (
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            {entry.documents.map((doc, i) => (
              <div key={doc.label} className={`flex items-center justify-between px-3 py-2.5 ${i < entry.documents.length - 1 ? 'border-b border-gray-50' : ''}`}>
                <span className="text-sm text-gray-700">{doc.label}</span>
                <span className={`text-xs font-medium capitalize ${docStatusColor[doc.status]}`}>
                  {doc.status === 'verified' && <CheckCircle className="h-3.5 w-3.5 inline mr-1" />}
                  {doc.status === 'uploaded'  && <Clock       className="h-3.5 w-3.5 inline mr-1" />}
                  {doc.status === 'missing'   && <XCircle     className="h-3.5 w-3.5 inline mr-1" />}
                  {doc.status}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3 pt-1">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 border-red-300 text-red-600 hover:bg-red-50"
            onClick={() => onReject(entry.id)}
          >
            <XCircle className="h-4 w-4" /> Reject
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="flex-1"
            onClick={() => onApprove(entry.id)}
          >
            <CheckCircle className="h-4 w-4" /> Approve
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function AdminApprovalsPage() {
  const [pending,       setPending]       = useState<PendingKYC[]>(MOCK_PENDING);
  const [approved,      setApproved]      = useState<string[]>([]);
  const [rejected,      setRejected]      = useState<{ id: string; remarks: string }[]>([]);
  const [rejectTarget,  setRejectTarget]  = useState<string | null>(null);

  const handleApprove = (id: string) => {
    setPending((p) => p.filter((e) => e.id !== id));
    setApproved((a) => [...a, id]);
  };

  const handleReject = (remarks: string) => {
    if (!rejectTarget) return;
    setPending((p) => p.filter((e) => e.id !== rejectTarget));
    setRejected((r) => [...r, { id: rejectTarget, remarks }]);
    setRejectTarget(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">KYC Approvals</h1>
        <p className="text-sm text-gray-500 mt-1">Final Gifsy validation queue — entries that have passed SO / ASM review</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4 text-center">
            <p className="text-2xl font-bold text-amber-600">{pending.length}</p>
            <p className="text-xs text-gray-500 mt-1">Pending Review</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4 text-center">
            <p className="text-2xl font-bold text-emerald-600">{approved.length}</p>
            <p className="text-xs text-gray-500 mt-1">Approved Today</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4 text-center">
            <p className="text-2xl font-bold text-red-600">{rejected.length}</p>
            <p className="text-xs text-gray-500 mt-1">Rejected Today</p>
          </CardContent>
        </Card>
      </div>

      {/* Pending queue */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Clock className="h-4 w-4 text-amber-500" />
          <h2 className="text-sm font-bold text-gray-800">Pending Validation</h2>
          {pending.length > 0 && (
            <span className="text-xs font-bold bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">{pending.length}</span>
          )}
        </div>

        {pending.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 bg-white rounded-2xl border border-gray-100">
            <CheckCircle className="h-10 w-10 text-emerald-400" />
            <p className="text-sm font-semibold text-gray-700">All clear!</p>
            <p className="text-xs text-gray-400">No KYC entries pending Gifsy validation</p>
          </div>
        ) : (
          <div className="space-y-4">
            {pending.map((entry) => (
              <KYCApprovalCard
                key={entry.id}
                entry={entry}
                onApprove={handleApprove}
                onReject={(id) => setRejectTarget(id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Completed today */}
      {(approved.length > 0 || rejected.length > 0) && (
        <div>
          <h2 className="text-sm font-bold text-gray-800 mb-3">Actioned Today</h2>
          <div className="space-y-2">
            {approved.map((id) => {
              const entry = MOCK_PENDING.find((e) => e.id === id);
              return entry ? (
                <div key={id} className="flex items-center gap-3 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl">
                  <CheckCircle className="h-4 w-4 text-emerald-600 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-gray-900">{entry.firmName}</p>
                    <p className="text-xs text-gray-500">{entry.partnerName}</p>
                  </div>
                  <Badge variant="success">Approved</Badge>
                </div>
              ) : null;
            })}
            {rejected.map(({ id, remarks }) => {
              const entry = MOCK_PENDING.find((e) => e.id === id);
              return entry ? (
                <div key={id} className="flex items-start gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-xl">
                  <XCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{entry.firmName}</p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">Remarks: {remarks}</p>
                  </div>
                  <Badge variant="danger">Rejected</Badge>
                </div>
              ) : null;
            })}
          </div>
        </div>
      )}

      {/* Rejection modal */}
      {rejectTarget && (
        <RejectionModal onConfirm={handleReject} onCancel={() => setRejectTarget(null)} />
      )}
    </div>
  );
}
