'use client';

import { useState } from 'react';
import { use } from 'react';
import {
  ArrowLeft,
  Building2,
  Phone,
  MapPin,
  Calendar,
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
  CreditCard,
  FileText,
} from 'lucide-react';
import Link from 'next/link';
import { KYCReviewer } from '@/components/admin/kyc-reviewer';

const KYC_DATA: Record<string, {
  id: string;
  outletName: string;
  firmName: string;
  mobile: string;
  email: string;
  partnerClass: string;
  gstNumber: string;
  panNumber: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  salesUser: string;
  territory: string;
  region: string;
  submittedDate: string;
  ageHrs: number;
  status: string;
  bankName: string;
  accountNumber: string;
  ifscCode: string;
  pennyDropStatus: 'verified' | 'failed' | 'pending';
  agreementStatus: 'signed' | 'pending';
  agreementDate: string;
  statusHistory: Array<{ status: string; timestamp: string; user: string; remark?: string }>;
  auditLog: Array<{ action: string; user: string; timestamp: string; detail: string }>;
  documents: Array<{ id: string; type: string; label: string; url: string; status: 'pending' | 'verified' | 'rejected' }>;
}> = {
  KYC001: {
    id: 'KYC001',
    outletName: 'Sharma General Store',
    firmName: 'Sharma General Store (Prop. Rakesh Sharma)',
    mobile: '9820184321',
    email: 'rakesh.sharma@gmail.com',
    partnerClass: 'GOLD',
    gstNumber: '27AABCS1429B1Z5',
    panNumber: 'AABCS1429B',
    address: 'Shop No. 12, Andheri Market',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400053',
    salesUser: 'Rohit Verma',
    territory: 'Mumbai West',
    region: 'West India',
    submittedDate: '2025-04-30',
    ageHrs: 18,
    status: 'PENDING',
    bankName: 'HDFC Bank',
    accountNumber: '50100XXXXXXXX12',
    ifscCode: 'HDFC0004832',
    pennyDropStatus: 'verified',
    agreementStatus: 'signed',
    agreementDate: '2025-04-29',
    statusHistory: [
      { status: 'SUBMITTED', timestamp: '2025-04-30 09:14', user: 'Rakesh Sharma (Partner)', remark: 'Initial KYC submission' },
      { status: 'PENDING', timestamp: '2025-04-30 09:15', user: 'System', remark: 'Assigned to KYC queue' },
    ],
    auditLog: [
      { action: 'KYC Submitted', user: 'Partner Self', timestamp: '2025-04-30 09:14', detail: 'Partner submitted KYC via mobile app' },
      { action: 'Documents Received', user: 'System', timestamp: '2025-04-30 09:14', detail: '5 documents uploaded and virus scanned' },
      { action: 'Penny Drop Initiated', user: 'System', timestamp: '2025-04-30 09:15', detail: 'Bank verification via HDFC0004832' },
      { action: 'Penny Drop Verified', user: 'System', timestamp: '2025-04-30 09:17', detail: 'Account holder name matched: RAKESH SHARMA' },
    ],
    documents: [
      { id: 'd1', type: 'pan', label: 'PAN Card', url: 'https://placehold.co/600x400/e2e8f0/1a1a2e?text=PAN+Card', status: 'pending' },
      { id: 'd2', type: 'gst', label: 'GST Certificate', url: 'https://placehold.co/600x400/e2e8f0/1a1a2e?text=GST+Certificate', status: 'verified' },
      { id: 'd3', type: 'bank', label: 'Cancelled Cheque', url: 'https://placehold.co/600x400/e2e8f0/1a1a2e?text=Cancelled+Cheque', status: 'verified' },
      { id: 'd4', type: 'address', label: 'Address Proof', url: 'https://placehold.co/600x400/e2e8f0/1a1a2e?text=Address+Proof', status: 'pending' },
      { id: 'd5', type: 'photo', label: 'Proprietor Photo', url: 'https://placehold.co/600x400/e2e8f0/1a1a2e?text=Proprietor+Photo', status: 'pending' },
    ],
  },
};

const STATUS_COLORS: Record<string, string> = {
  SUBMITTED: 'bg-blue-100 text-blue-700',
  PENDING: 'bg-amber-100 text-amber-700',
  UNDER_REVIEW: 'bg-purple-100 text-purple-700',
  APPROVED: 'bg-green-100 text-green-700',
  REJECTED: 'bg-red-100 text-red-700',
  RESUBMISSION_REQUIRED: 'bg-orange-100 text-orange-700',
};

const PENNY_ICONS = {
  verified: <CheckCircle className="w-4 h-4 text-green-500" />,
  failed: <XCircle className="w-4 h-4 text-red-500" />,
  pending: <Clock className="w-4 h-4 text-amber-500" />,
};

export default function KYCDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const kyc = KYC_DATA[id];
  const [actionResult, setActionResult] = useState<string | null>(null);

  if (!kyc) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500 text-sm">KYC submission not found</p>
        <Link href="/kyc" className="text-[#C8102E] text-sm mt-2 inline-block">← Back to KYC List</Link>
      </div>
    );
  }

  const handleApprove = (id: string) => {
    setActionResult(`KYC ${id} approved successfully. Partner notified via WhatsApp.`);
  };
  const handleReject = (id: string, reason: string) => {
    setActionResult(`KYC ${id} rejected. Reason: ${reason}`);
  };
  const handleReupload = (id: string, reason: string) => {
    setActionResult(`Re-upload requested for KYC ${id}. Partner notified. Reason: ${reason}`);
  };

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/kyc"
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-lg font-bold text-gray-900">{kyc.outletName}</h1>
            <p className="text-xs text-gray-500">KYC ID: {kyc.id} · Submitted: {kyc.submittedDate}</p>
          </div>
        </div>
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${STATUS_COLORS[kyc.status]}`}>
          {kyc.status.replace('_', ' ')}
        </span>
      </div>

      {actionResult && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-4 flex items-center gap-2 text-sm text-green-700">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          {actionResult}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left column */}
        <div className="space-y-4">
          {/* Partner Info */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-[#C8102E]" />
              Partner Information
            </h2>
            <div className="space-y-2.5 text-xs">
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Firm Name</span>
                <span className="text-gray-800 font-medium">{kyc.firmName}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Class</span>
                <span className="text-amber-700 font-semibold bg-amber-50 px-2 py-0.5 rounded-full">{kyc.partnerClass}</span>
              </div>
              <div className="flex gap-2 items-center">
                <span className="text-gray-500 w-24 flex-shrink-0">Mobile</span>
                <span className="flex items-center gap-1 text-gray-800">
                  <Phone className="w-3 h-3" /> {kyc.mobile}
                </span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Email</span>
                <span className="text-gray-800">{kyc.email}</span>
              </div>
              <div className="flex gap-2 items-start">
                <span className="text-gray-500 w-24 flex-shrink-0">Address</span>
                <span className="text-gray-800">
                  {kyc.address}, {kyc.city}, {kyc.state} - {kyc.pincode}
                </span>
              </div>
            </div>
          </div>

          {/* Tax Info */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4 text-[#C8102E]" />
              Tax & Registration
            </h2>
            <div className="space-y-2 text-xs">
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">PAN</span>
                <span className="font-mono text-gray-800 font-medium">{kyc.panNumber}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">GSTIN</span>
                <span className="font-mono text-gray-800 font-medium">{kyc.gstNumber}</span>
              </div>
            </div>
          </div>

          {/* Bank Details */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-[#C8102E]" />
              Bank Details
            </h2>
            <div className="space-y-2 text-xs">
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Bank</span>
                <span className="text-gray-800 font-medium">{kyc.bankName}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Account No.</span>
                <span className="font-mono text-gray-800">{kyc.accountNumber}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">IFSC</span>
                <span className="font-mono text-gray-800">{kyc.ifscCode}</span>
              </div>
              <div className="flex gap-2 items-center">
                <span className="text-gray-500 w-24 flex-shrink-0">Penny Drop</span>
                <span className={`flex items-center gap-1 font-medium ${
                  kyc.pennyDropStatus === 'verified' ? 'text-green-600' :
                  kyc.pennyDropStatus === 'failed' ? 'text-red-600' : 'text-amber-600'
                }`}>
                  {PENNY_ICONS[kyc.pennyDropStatus]}
                  {kyc.pennyDropStatus.charAt(0).toUpperCase() + kyc.pennyDropStatus.slice(1)}
                </span>
              </div>
            </div>
          </div>

          {/* Agreement & Sales */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <MapPin className="w-4 h-4 text-[#C8102E]" />
              Assignment & Agreement
            </h2>
            <div className="space-y-2 text-xs">
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Sales User</span>
                <span className="text-gray-800">{kyc.salesUser}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Territory</span>
                <span className="text-gray-800">{kyc.territory}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Region</span>
                <span className="text-gray-800">{kyc.region}</span>
              </div>
              <div className="flex gap-2 items-center">
                <span className="text-gray-500 w-24 flex-shrink-0">Agreement</span>
                <span className={`flex items-center gap-1 font-medium ${
                  kyc.agreementStatus === 'signed' ? 'text-green-600' : 'text-amber-600'
                }`}>
                  {kyc.agreementStatus === 'signed' ? <CheckCircle className="w-3.5 h-3.5" /> : <Clock className="w-3.5 h-3.5" />}
                  {kyc.agreementStatus === 'signed' ? `Signed on ${kyc.agreementDate}` : 'Pending Signature'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Middle & Right: Document Viewer + Actions */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-4">Document Review</h2>
            <KYCReviewer
              partnerId={kyc.id}
              partnerName={kyc.outletName}
              documents={kyc.documents}
              onApprove={handleApprove}
              onReject={handleReject}
              onRequestReupload={handleReupload}
            />
          </div>

          {/* Status History Timeline */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Clock className="w-4 h-4 text-[#C8102E]" />
              Status History
            </h2>
            <div className="relative">
              <div className="absolute left-3.5 top-0 bottom-0 w-px bg-gray-200" />
              <div className="space-y-4">
                {kyc.statusHistory.map((entry, i) => (
                  <div key={i} className="flex gap-4 relative">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 z-10 ${
                      STATUS_COLORS[entry.status] ?? 'bg-gray-100 text-gray-600'
                    }`}>
                      <span className="text-xs font-bold">{i + 1}</span>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-gray-800">{entry.status.replace('_', ' ')}</p>
                      <p className="text-xs text-gray-500">{entry.timestamp} · {entry.user}</p>
                      {entry.remark && (
                        <p className="text-xs text-gray-600 mt-0.5 bg-gray-50 px-2 py-1 rounded">{entry.remark}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Audit Log */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <FileText className="w-4 h-4 text-[#C8102E]" />
              Audit Log
            </h2>
            <div className="space-y-3">
              {kyc.auditLog.map((log, i) => (
                <div key={i} className="flex gap-3 text-xs border-b border-gray-50 pb-3 last:border-0 last:pb-0">
                  <div className="text-gray-400 w-36 flex-shrink-0">
                    <p className="text-gray-800 font-medium">{log.timestamp}</p>
                    <p className="text-gray-500">{log.user}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-gray-800">{log.action}</p>
                    <p className="text-gray-500">{log.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
