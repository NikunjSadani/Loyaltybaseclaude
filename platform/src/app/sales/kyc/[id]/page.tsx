'use client';

import { use, useState, useEffect } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Building2, Phone, MapPin, User,
  CheckCircle, XCircle, Clock, AlertTriangle,
  CreditCard, Camera, ChevronRight, ChevronDown,
  BookOpen, Gift, HeadphonesIcon, Target, ThumbsUp,
  TrendingUp, ShoppingCart,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KYCStatus, type ApprovalEvent, type KYCSubmitterRole } from '@/types';
import {
  type GeoTargetConfig,
  resolveConfig, OUTLET_ACHIEVEMENTS,
  pct, pctBg, pctBarColor, getPrimaryParam,
} from '@/lib/targets';
import { getRole, resolveApprover, statusForApprover, type SalesRole } from '@/lib/sales-role';
import { getGifsySettings } from '@/lib/gifsy-settings';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

interface KYCDetail {
  id: string;
  partnerName: string;
  firmName: string;
  mobile: string;
  address: string;
  city: string;
  state: string;
  partnerClass: string;
  outletCode?: string;
  outletType?: 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';
  status: KYCStatus;
  submittedAt: string;
  submittedByRole: KYCSubmitterRole;
  submittedByName: string;
  lastOrderDate?: string;
  rejectionReason?: string;
  gstNumber?: string;
  panNumber?: string;
  bankName?: string;
  accountNumber?: string;
  ifscCode?: string;
  documents: { label: string; status: 'uploaded' | 'missing' | 'verified' }[];
  approvalHistory: ApprovalEvent[];
}

/* ─── Mock data ──────────────────────────────────────────────────────────────── */

const MOCK_KYC: Record<string, KYCDetail> = {
  k1: {
    id: 'k1', partnerName: 'Rajesh Kumar', firmName: 'Kumar General Store',
    mobile: '9876543210', address: '12 Market Road, Andheri', city: 'Mumbai', state: 'Maharashtra',
    partnerClass: 'GOLD', outletCode: 'OUT-MH-0101', outletType: 'SSS',
    status: KYCStatus.APPROVED, submittedAt: '2026-04-01',
    submittedByRole: 'XSR', submittedByName: 'Ramesh Iyer',
    lastOrderDate: '2026-05-20',
    gstNumber: '27AAPFU0939F1ZV', panNumber: 'AAPFU0939F',
    bankName: 'HDFC Bank', accountNumber: '****7890', ifscCode: 'HDFC0001234',
    documents: [
      { label: 'GST Certificate', status: 'verified' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Owner Photo', status: 'verified' },     { label: 'Board Photo', status: 'verified' },
      { label: 'Bank Passbook', status: 'verified' },
    ],
    approvalHistory: [
      { stage: 'FIRST_APPROVER', action: 'APPROVED', by: 'Rajesh Kumar', role: 'SO', timestamp: '2026-04-03T10:30:00' },
      { stage: 'GIFSY',          action: 'APPROVED', by: 'Gifsy Admin',  role: 'GIFSY', timestamp: '2026-04-05T14:20:00' },
    ],
  },
  k2: {
    id: 'k2', partnerName: 'Amit Sharma', firmName: 'Sharma Kirana',
    mobile: '9765432109', address: '5 Station Road, Borivali', city: 'Mumbai', state: 'Maharashtra',
    partnerClass: 'SILVER', status: KYCStatus.PENDING_SO_APPROVAL, submittedAt: '2026-05-10',
    submittedByRole: 'XSR', submittedByName: 'Ramesh Iyer',
    documents: [
      { label: 'GST Certificate', status: 'uploaded' }, { label: 'PAN Card', status: 'uploaded' },
      { label: 'Shop Photo', status: 'uploaded' },      { label: 'Bank Passbook', status: 'missing' },
    ],
    approvalHistory: [],
  },
  k3: {
    id: 'k3', partnerName: 'Suresh Patel', firmName: 'Patel Grocery',
    mobile: '9654321098', address: 'Shop 3, MG Road', city: 'Thane', state: 'Maharashtra',
    partnerClass: 'BRONZE', outletCode: 'OUT-MH-0103', outletType: 'SSS',
    status: KYCStatus.REJECTED, submittedAt: '2026-04-20',
    submittedByRole: 'XSR', submittedByName: 'Ramesh Iyer',
    rejectionReason: 'GST certificate invalid — number mismatch with shop name.',
    documents: [
      { label: 'GST Certificate', status: 'uploaded' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Owner Photo', status: 'uploaded' },     { label: 'Board Photo', status: 'uploaded' },
      { label: 'Bank Passbook', status: 'uploaded' },
    ],
    approvalHistory: [
      { stage: 'FIRST_APPROVER', action: 'REJECTED', by: 'Rajesh Kumar', role: 'SO', timestamp: '2026-05-01T09:15:00', remarks: 'GST certificate invalid — number mismatch with shop name.' },
    ],
  },
  k4: {
    id: 'k4', partnerName: 'Gurpreet Singh', firmName: 'Singh Supermart',
    mobile: '9543210987', address: '78 Link Road, Malad', city: 'Mumbai', state: 'Maharashtra',
    partnerClass: 'GOLD', outletCode: 'OUT-MH-0104', outletType: 'WHOLESALER',
    status: KYCStatus.APPROVED, submittedAt: '2026-03-15',
    submittedByRole: 'SO', submittedByName: 'Rajesh Kumar',
    lastOrderDate: '2026-05-25',
    gstNumber: '27AAPFU0939F1ZV', panNumber: 'BBBPS1234C',
    bankName: 'ICICI Bank', accountNumber: '****4567', ifscCode: 'ICIC0001122',
    documents: [
      { label: 'GST Certificate', status: 'verified' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Shop Photo', status: 'verified' },      { label: 'Bank Passbook', status: 'verified' },
    ],
    approvalHistory: [
      { stage: 'FIRST_APPROVER', action: 'APPROVED', by: 'Sanjay Kapoor', role: 'ASM', timestamp: '2026-03-17T11:00:00' },
      { stage: 'GIFSY',          action: 'APPROVED', by: 'Gifsy Admin',   role: 'GIFSY', timestamp: '2026-03-20T16:30:00' },
    ],
  },
  k5: {
    id: 'k5', partnerName: 'Vijay Mehta', firmName: 'Mehta Provisions',
    mobile: '9432109876', address: 'Plot 22, New Link Road, Kandivali', city: 'Mumbai', state: 'Maharashtra',
    partnerClass: 'SILVER', status: KYCStatus.PENDING_GIFSY, submittedAt: '2026-05-14',
    submittedByRole: 'SO', submittedByName: 'Rajesh Kumar',
    lastOrderDate: '2026-05-10',
    documents: [
      { label: 'GST Certificate', status: 'uploaded' }, { label: 'PAN Card', status: 'uploaded' },
      { label: 'Shop Photo', status: 'uploaded' },      { label: 'Bank Passbook', status: 'uploaded' },
    ],
    approvalHistory: [
      { stage: 'FIRST_APPROVER', action: 'APPROVED', by: 'Sanjay Kapoor', role: 'ASM', timestamp: '2026-05-15T14:00:00' },
    ],
  },
  k6: {
    id: 'k6', partnerName: 'Priya Desai', firmName: 'Desai Grocers',
    mobile: '9321098765', address: '1 Old Market, Goregaon', city: 'Mumbai', state: 'Maharashtra',
    partnerClass: 'BRONZE', status: KYCStatus.PENDING_ASM_APPROVAL, submittedAt: '2026-05-12',
    submittedByRole: 'SO', submittedByName: 'Rajesh Kumar',
    documents: [
      { label: 'GST Certificate', status: 'uploaded' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Shop Photo', status: 'uploaded' },      { label: 'Bank Passbook', status: 'uploaded' },
    ],
    approvalHistory: [],
  },
  k7: {
    id: 'k7', partnerName: 'Suresh Nair', firmName: 'Suresh Wholesale',
    mobile: '9210987654', address: '11 Station Rd, Kurla', city: 'Mumbai', state: 'Maharashtra',
    partnerClass: 'SILVER', status: KYCStatus.RE_KYC_REQUIRED, submittedAt: '2026-03-10',
    submittedByRole: 'SO', submittedByName: 'Rajesh Kumar',
    lastOrderDate: '2026-05-18',
    gstNumber: '27BBBFU1234F1ZV', panNumber: 'BBBFU1234F',
    bankName: 'SBI', accountNumber: '****3210', ifscCode: 'SBIN0001234',
    documents: [
      { label: 'GST Certificate', status: 'verified' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Shop Photo', status: 'verified' },      { label: 'Bank Passbook', status: 'verified' },
    ],
    rejectionReason: 'KYC expired — renewal required.',
    approvalHistory: [
      { stage: 'FIRST_APPROVER', action: 'APPROVED', by: 'Sanjay Kapoor', role: 'ASM', timestamp: '2026-03-12T10:00:00' },
      { stage: 'GIFSY',          action: 'APPROVED', by: 'Gifsy Admin',   role: 'GIFSY', timestamp: '2026-03-14T09:00:00' },
    ],
  },
  k8: {
    id: 'k8', partnerName: 'Gurpreet Singh', firmName: 'Singh Supermart',
    mobile: '9543210987', address: '78 Link Road, Malad', city: 'Mumbai', state: 'Maharashtra',
    partnerClass: 'GOLD', status: KYCStatus.RE_KYC_REQUIRED, submittedAt: '2026-03-15',
    submittedByRole: 'SO', submittedByName: 'Rajesh Kumar',
    lastOrderDate: '2026-05-22',
    rejectionReason: 'GST number updated — re-verify required.',
    documents: [
      { label: 'GST Certificate', status: 'uploaded' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Shop Photo', status: 'verified' },      { label: 'Bank Passbook', status: 'verified' },
    ],
    approvalHistory: [],
  },
};

const OUTLET_MAP: Record<string, string> = { o1: 'k1', o2: 'k2', o3: 'k3', o4: 'k4', o5: 'k5' };

/** Only real UUIDs from the database should trigger an API fetch.
 *  Mock keys like 'k1', 'o1' would 404 unconditionally — skip them. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ─── Camera-only documents ──────────────────────────────────────────────────── */

/** Documents that must be captured on-site via camera (not gallery/PDF). */
const CAMERA_ONLY_DOCS = new Set(['Owner Photo', 'Board Photo', 'Shop Photo']);

/* ─── Past performance mock data ─────────────────────────────────────────────── */

const PAST_PERF: Record<string, { month: string; achievePct: number }[]> = {
  k1: [
    { month: 'Dec', achievePct: 102 }, { month: 'Jan', achievePct: 91 },
    { month: 'Feb', achievePct: 88 },  { month: 'Mar', achievePct: 100 },
    { month: 'Apr', achievePct: 94 },  { month: 'May', achievePct: 85 },
  ],
  k2: [
    { month: 'Dec', achievePct: 72 }, { month: 'Jan', achievePct: 65 },
    { month: 'Feb', achievePct: 55 }, { month: 'Mar', achievePct: 62 },
    { month: 'Apr', achievePct: 48 }, { month: 'May', achievePct: 40 },
  ],
  k3: [
    { month: 'Dec', achievePct: 50 }, { month: 'Jan', achievePct: 44 },
    { month: 'Feb', achievePct: 44 }, { month: 'Mar', achievePct: 50 },
    { month: 'Apr', achievePct: 35 }, { month: 'May', achievePct: 28 },
  ],
  k4: [
    { month: 'Dec', achievePct: 98 },  { month: 'Jan', achievePct: 105 },
    { month: 'Feb', achievePct: 100 }, { month: 'Mar', achievePct: 92 },
    { month: 'Apr', achievePct: 97 },  { month: 'May', achievePct: 91 },
  ],
};

/* ─── API types & mapping (leaderboard pattern) ─────────────────────────────── */

interface ApiSalesKYC {
  id: string;
  status: string;
  submittedAt: string;
  rejectionReason?: string | null;
  user: { id: string; name: string; phone: string; role: string };
  partner: {
    id: string;
    businessName: string;
    gstNumber?: string;
    panNumber?: string;
    address: string;
    city: string;
    state: string;
    bankName?: string;
    bankAccountNumber?: string;
    ifscCode?: string;
  };
  documents?: { label: string; status?: string }[];
}

function mapApiSalesKYC(s: ApiSalesKYC): KYCDetail {
  return {
    id: s.id,
    partnerName: s.user.name,
    firmName: s.partner.businessName,
    mobile: s.user.phone,
    address: s.partner.address,
    city: s.partner.city,
    state: s.partner.state,
    partnerClass: '',
    status: (s.status as KYCStatus) ?? KYCStatus.SUBMITTED,
    submittedAt: s.submittedAt,
    submittedByRole: (s.user.role as KYCSubmitterRole) ?? 'SO',
    submittedByName: s.user.name,
    rejectionReason: s.rejectionReason ?? undefined,
    gstNumber: s.partner.gstNumber,
    panNumber: s.partner.panNumber,
    bankName: s.partner.bankName,
    accountNumber: s.partner.bankAccountNumber,
    ifscCode: s.partner.ifscCode,
    documents: (s.documents ?? []).map(d => ({
      label: d.label,
      status: (d.status as 'uploaded' | 'missing' | 'verified') ?? 'uploaded',
    })),
    approvalHistory: [],
  };
}

/* ─── Status config ──────────────────────────────────────────────────────────── */

const statusConfig: Partial<Record<KYCStatus, { variant: 'success' | 'warning' | 'danger' | 'info' | 'default'; label: string }>> = {
  [KYCStatus.APPROVED]:              { variant: 'success', label: 'Approved'           },
  [KYCStatus.PENDING]:               { variant: 'warning', label: 'Draft'              },
  [KYCStatus.SUBMITTED]:             { variant: 'info',    label: 'Submitted'          },
  [KYCStatus.UNDER_REVIEW]:          { variant: 'info',    label: 'Under Review'       },
  [KYCStatus.PENDING_SO_APPROVAL]:   { variant: 'warning', label: 'Awaiting SO'        },
  [KYCStatus.PENDING_ASM_APPROVAL]:  { variant: 'warning', label: 'Awaiting ASM'       },
  [KYCStatus.PENDING_GIFSY]:         { variant: 'info',    label: 'Awaiting Gifsy'     },
  [KYCStatus.REJECTED]:              { variant: 'danger',  label: 'Rejected'           },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger',  label: 'Re-upload Required' },
  [KYCStatus.RE_KYC_REQUIRED]:       { variant: 'warning', label: 'Re-KYC Required'   },
};

const docStatusColor: Record<string, string> = {
  verified: 'text-emerald-600',
  uploaded: 'text-blue-600',
  missing:  'text-red-500',
};

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

function relativeDate(dateStr: string): string {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (diff === 0)  return 'Today';
  if (diff === 1)  return 'Yesterday';
  if (diff < 30)   return `${diff} days ago`;
  const months = Math.floor(diff / 30);
  return `${months} month${months !== 1 ? 's' : ''} ago`;
}

/* ─── Pace helpers ───────────────────────────────────────────────────────────── */

function computeMonthPace(): { timePct: number; daysLeft: number; elapsed: number; daysInMonth: number } {
  const today      = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const elapsed    = today.getDate();
  const daysLeft   = daysInMonth - elapsed;
  const timePct    = Math.round((elapsed / daysInMonth) * 100);
  return { timePct, daysLeft, elapsed, daysInMonth };
}

function paceBadge(achievePct: number, timePct: number): { label: string; bg: string; text: string; strip: string } {
  const gap = timePct - achievePct;
  if (gap <= 0)  return { label: 'On pace',            bg: 'bg-emerald-50', text: 'text-emerald-700', strip: 'bg-emerald-400' };
  if (gap <= 15) return { label: `${gap}% behind pace`, bg: 'bg-amber-50',   text: 'text-amber-700',   strip: 'bg-amber-400'   };
  return           { label: `${gap}% behind pace`, bg: 'bg-red-50',     text: 'text-red-600',     strip: 'bg-red-400'     };
}

/* ─── Approval Timeline ──────────────────────────────────────────────────────── */

type StepState = 'complete' | 'active' | 'rejected' | 'pending';

interface TimelineStep {
  label:    string;
  sublabel: string;
  state:    StepState;
}

function buildTimeline(kyc: KYCDetail): TimelineStep[] {
  const firstApproverLabel = kyc.submittedByRole === 'XSR' ? 'SO Review' : 'ASM Review';
  const firstApproverEvent = kyc.approvalHistory.find((e) => e.stage === 'FIRST_APPROVER');
  const gifsyEvent         = kyc.approvalHistory.find((e) => e.stage === 'GIFSY');

  const step1: TimelineStep = {
    label: 'Submitted',
    sublabel: `${kyc.submittedByName} · ${new Date(kyc.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`,
    state: 'complete',
  };

  let step2State: StepState = 'pending';
  let step2Sub   = 'Pending review';
  if (firstApproverEvent) {
    step2State = firstApproverEvent.action === 'APPROVED' ? 'complete' : 'rejected';
    step2Sub   = firstApproverEvent.action === 'APPROVED'
      ? `Approved by ${firstApproverEvent.by}`
      : `Rejected by ${firstApproverEvent.by}`;
  } else if (
    kyc.status === KYCStatus.PENDING_SO_APPROVAL ||
    kyc.status === KYCStatus.PENDING_ASM_APPROVAL
  ) {
    step2State = 'active';
    step2Sub   = 'Awaiting review';
  }

  let step3State: StepState = 'pending';
  let step3Sub   = 'Pending first approval';
  if (gifsyEvent) {
    step3State = gifsyEvent.action === 'APPROVED' ? 'complete' : 'rejected';
    step3Sub   = gifsyEvent.action === 'APPROVED' ? 'Approved' : `Rejected — ${gifsyEvent.remarks ?? ''}`;
  } else if (kyc.status === KYCStatus.PENDING_GIFSY) {
    step3State = 'active';
    step3Sub   = 'Under Gifsy review';
  } else if (firstApproverEvent?.action === 'APPROVED') {
    step3Sub = 'Queued for Gifsy';
  }

  return [
    step1,
    { label: firstApproverLabel, sublabel: step2Sub, state: step2State },
    { label: 'Gifsy Validation',  sublabel: step3Sub, state: step3State },
  ];
}

function StepDot({ state }: { state: StepState }) {
  if (state === 'complete') return (
    <div className="w-7 h-7 rounded-full bg-emerald-100 border-2 border-emerald-500 flex items-center justify-center shrink-0">
      <CheckCircle className="h-3.5 w-3.5 text-emerald-600" />
    </div>
  );
  if (state === 'rejected') return (
    <div className="w-7 h-7 rounded-full bg-red-100 border-2 border-red-500 flex items-center justify-center shrink-0">
      <XCircle className="h-3.5 w-3.5 text-red-600" />
    </div>
  );
  if (state === 'active') return (
    <div className="w-7 h-7 rounded-full bg-amber-100 border-2 border-amber-500 flex items-center justify-center shrink-0">
      <Clock className="h-3.5 w-3.5 text-amber-600" />
    </div>
  );
  return (
    <div className="w-7 h-7 rounded-full bg-gray-100 border-2 border-gray-300 flex items-center justify-center shrink-0">
      <div className="w-2 h-2 rounded-full bg-gray-300" />
    </div>
  );
}

function ApprovalTimeline({ kyc }: { kyc: KYCDetail }) {
  const steps = buildTimeline(kyc);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ThumbsUp className="h-4 w-4 text-[#16a34a]" /> Approval Status
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 pb-3">
        {steps.map((step, i) => (
          <div key={step.label} className="flex gap-3">
            {/* Left: dot + connector */}
            <div className="flex flex-col items-center">
              <StepDot state={step.state} />
              {i < steps.length - 1 && (
                <div className={`w-0.5 flex-1 my-1 rounded-full ${
                  step.state === 'complete' ? 'bg-emerald-300' :
                  step.state === 'rejected' ? 'bg-red-200' : 'bg-gray-200'
                }`} style={{ minHeight: 20 }} />
              )}
            </div>
            {/* Right: text */}
            <div className={`pb-4 ${i === steps.length - 1 ? 'pb-0' : ''}`}>
              <p className={`text-sm font-semibold leading-tight ${
                step.state === 'complete' ? 'text-emerald-700' :
                step.state === 'rejected' ? 'text-red-700' :
                step.state === 'active'   ? 'text-amber-700' : 'text-gray-400'
              }`}>{step.label}</p>
              <p className="text-xs text-gray-400 mt-0.5 leading-snug">{step.sublabel}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ─── Rejection modal ────────────────────────────────────────────────────────── */

function RejectionModal({
  onConfirm, onCancel,
}: {
  onConfirm: (remarks: string) => void;
  onCancel: () => void;
}) {
  const [remarks, setRemarks] = useState('');
  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div className="relative w-full bg-white rounded-t-2xl p-5 space-y-4">
        <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto" />
        <h3 className="text-base font-bold text-gray-900">Rejection Remarks</h3>
        <p className="text-xs text-gray-500">Provide a reason for rejection. This will be visible to the submitter.</p>
        <textarea
          value={remarks}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="e.g. GST certificate is blurry — please re-upload a clear scan."
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

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function SalesKYCDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id }        = use(params);
  const resolvedId    = OUTLET_MAP[id] ?? id;
  const [kyc, setKyc] = useState<KYCDetail | null>(MOCK_KYC[resolvedId] ?? null);

  const [submitting,        setSubmitting]        = useState(false);
  const [approving,         setApproving]         = useState(false);
  const [showRejectModal,   setShowRejectModal]   = useState(false);
  const [targetConfig,      setTargetConfig]      = useState<GeoTargetConfig | null>(null);
  const [role,              setRoleState]         = useState<string>('SO');
  const [detailsOpen,       setDetailsOpen]       = useState(false);
  const [photoLightboxOpen, setPhotoLightboxOpen] = useState(false);
  const [resubmitFiles,     setResubmitFiles]     = useState<File[]>([]);
  const [resubmitting,      setResubmitting]      = useState(false);
  const [escalatedFrom,     setEscalatedFrom]     = useState<SalesRole | null>(null);
  const [settings,          setSettings]          = useState(() => getGifsySettings());

  /* ── Dynamic period: always current month ── */
  const now           = new Date();
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const periodLabel   = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const monthPace     = computeMonthPace();

  useEffect(() => {
    setRoleState(getRole());
    setTargetConfig(resolveConfig('Andheri Beat', 'Mumbai West', 'Maharashtra', currentPeriod));
    setSettings(getGifsySettings());
  }, [currentPeriod]);

  /* ── API hydration — silent background update (leaderboard pattern) ── */
  useEffect(() => {
    // Only fetch for real UUIDs — mock keys (k1, o1, etc.) would 404 unconditionally.
    if (!UUID_RE.test(id)) return;

    fetch(`/api/kyc/${id}`)
      .then(r => r.json())
      .then((json) => {
        if (json.success && json.data?.submission) {
          const s = json.data.submission;
          // Merge pattern: selectively overwrite only fields the API returns.
          // This preserves approvalHistory, partnerClass, outletCode,
          // lastOrderDate, and any other fields not present in the API shape.
          setKyc(prev => {
            if (prev) {
              return {
                ...prev,
                partnerName:     s.user?.name                    ?? prev.partnerName,
                firmName:        s.partner?.businessName         ?? prev.firmName,
                mobile:          s.user?.phone                   ?? prev.mobile,
                address:         s.partner?.address              ?? prev.address,
                city:            s.partner?.city                 ?? prev.city,
                state:           s.partner?.state                ?? prev.state,
                status:          (s.status as KYCStatus)         ?? prev.status,
                submittedAt:     s.submittedAt                   ?? prev.submittedAt,
                submittedByRole: (s.user?.role as KYCSubmitterRole) ?? prev.submittedByRole,
                submittedByName: s.user?.name                    ?? prev.submittedByName,
                rejectionReason: s.rejectionReason               ?? prev.rejectionReason,
                gstNumber:       s.partner?.gstNumber            ?? prev.gstNumber,
                panNumber:       s.partner?.panNumber            ?? prev.panNumber,
                bankName:        s.partner?.bankName             ?? prev.bankName,
                accountNumber:   s.partner?.bankAccountNumber    ?? prev.accountNumber,
                ifscCode:        s.partner?.ifscCode             ?? prev.ifscCode,
                documents:       s.documents?.length
                  ? (s.documents as { label: string; status?: string }[]).map(d => ({
                      label:  d.label,
                      status: (d.status as 'uploaded' | 'missing' | 'verified') ?? 'uploaded',
                    }))
                  : prev.documents,
                // approvalHistory and partnerClass are NOT returned by the API.
                // They stay as whatever is already in state.
              };
            }
            // prev is null → UUID not in MOCK_KYC → hydrate fresh from API data
            return {
              id:              s.id,
              partnerName:     s.user?.name                    ?? '',
              firmName:        s.partner?.businessName         ?? '',
              mobile:          s.user?.phone                   ?? '',
              address:         s.partner?.address              ?? '',
              city:            s.partner?.city                 ?? '',
              state:           s.partner?.state                ?? '',
              partnerClass:    '',
              status:          (s.status as KYCStatus)         ?? KYCStatus.SUBMITTED,
              submittedAt:     s.submittedAt                   ?? new Date().toISOString(),
              submittedByRole: (s.user?.role as KYCSubmitterRole) ?? 'SO',
              submittedByName: s.user?.name                    ?? '',
              rejectionReason: s.rejectionReason               ?? undefined,
              gstNumber:       s.partner?.gstNumber,
              panNumber:       s.partner?.panNumber,
              bankName:        s.partner?.bankName,
              accountNumber:   s.partner?.bankAccountNumber,
              ifscCode:        s.partner?.ifscCode,
              documents:       (s.documents ?? []).map((d: { label: string; status?: string }) => ({
                label:  d.label,
                status: (d.status as 'uploaded' | 'missing' | 'verified') ?? 'uploaded',
              })),
              approvalHistory: [],
            };
          });
        }
      })
      .catch(() => {}); // keep MOCK_KYC fallback on any error
  }, [id]);

  const achievement = OUTLET_ACHIEVEMENTS[resolvedId];

  if (!kyc) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <AlertTriangle className="h-10 w-10 text-amber-400" />
        <p className="text-gray-500 text-sm">KYC record not found</p>
        <Link href="/sales/kyc"><Button variant="outline" size="sm">← Back to KYC List</Button></Link>
      </div>
    );
  }

  const statusCfg = statusConfig[kyc.status];
  const isApproved = kyc.status === KYCStatus.APPROVED;

  /* ── Who can act on this entry? ── */
  const canApprove =
    (role === 'SO'  && kyc.status === KYCStatus.PENDING_SO_APPROVAL) ||
    (role === 'ASM' && kyc.status === KYCStatus.PENDING_ASM_APPROVAL);

  const handleApprove = async () => {
    setApproving(true);
    await new Promise(r => setTimeout(r, 800));
    const newEvent: ApprovalEvent = {
      stage:     'FIRST_APPROVER',
      action:    'APPROVED',
      by:        role === 'SO' ? 'Rajesh Kumar' : 'Sanjay Kapoor',
      role,
      timestamp: new Date().toISOString(),
    };
    setKyc((prev) => prev ? {
      ...prev,
      status: KYCStatus.PENDING_GIFSY,
      approvalHistory: [...prev.approvalHistory, newEvent],
    } : prev);
    setApproving(false);
  };

  const handleReject = async (remarks: string) => {
    setShowRejectModal(false);
    setApproving(true);
    await new Promise(r => setTimeout(r, 800));
    const newEvent: ApprovalEvent = {
      stage:     'FIRST_APPROVER',
      action:    'REJECTED',
      by:        role === 'SO' ? 'Rajesh Kumar' : 'Sanjay Kapoor',
      role,
      timestamp: new Date().toISOString(),
      remarks,
    };
    setKyc((prev) => prev ? {
      ...prev,
      status: KYCStatus.REJECTED,
      rejectionReason: remarks,
      approvalHistory: [...prev.approvalHistory, newEvent],
    } : prev);
    setApproving(false);
  };

  const handleSubmitForReview = async () => {
    setSubmitting(true);
    await new Promise(r => setTimeout(r, 1000));
    const nextStatus = role === 'XSR' ? KYCStatus.PENDING_SO_APPROVAL : KYCStatus.PENDING_ASM_APPROVAL;
    setKyc((prev) => prev ? { ...prev, status: nextStatus } : prev);
    setSubmitting(false);
  };

  const handleResubmit = async () => {
    if (resubmitFiles.length === 0 || !kyc) return;
    setResubmitting(true);
    await new Promise(r => setTimeout(r, 1000));
    const submitterRole = kyc.submittedByRole as SalesRole;
    const approverRole  = resolveApprover(submitterRole);
    const nextStatus    = statusForApprover(approverRole) as KYCStatus;
    const escalated     = approverRole !== (submitterRole === 'XSR' ? 'SO' : submitterRole === 'SO' ? 'ASM' : 'RSM');
    if (escalated) setEscalatedFrom(approverRole === 'ASM' ? 'SO' : 'ASM');
    setKyc((prev) => prev ? { ...prev, status: nextStatus, rejectionReason: undefined } : prev);
    setResubmitFiles([]);
    setResubmitting(false);
  };

  /* ── Target section helpers ── */
  const heroParam   = targetConfig ? getPrimaryParam(targetConfig.params) : null;
  const otherParams = targetConfig?.params.filter(p => !p.isPrimary) ?? [];

  const overallPct = targetConfig && achievement
    ? Math.round(
        targetConfig.params
          .map(p => pct(achievement.achievements[p.id] ?? 0, p.target))
          .reduce((a, b) => a + b, 0) / targetConfig.params.length
      )
    : 0;

  const pace = paceBadge(overallPct, monthPace.timePct);

  return (
    <div className="space-y-4 fade-in">
      {/* Back + header */}
      <div className="flex items-center gap-3">
        <Link href="/sales/kyc" className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4 text-gray-600" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-bold text-gray-900 truncate">{kyc.firmName}</h1>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs text-gray-500">{kyc.partnerName} · {kyc.id}</p>
              {kyc.outletCode && (
                <span data-testid="kyc-header-outlet-code" className="font-mono text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
                  {kyc.outletCode}
                </span>
              )}
            </div>
            {kyc.lastOrderDate && (
              <span className="flex items-center gap-1 text-[10px] font-semibold text-[#16a34a] bg-emerald-50 px-1.5 py-0.5 rounded-full">
                <ShoppingCart className="h-2.5 w-2.5" />
                Last order {relativeDate(kyc.lastOrderDate)}
              </span>
            )}
          </div>
        </div>
        {statusCfg && <Badge variant={statusCfg.variant} className="shrink-0">{statusCfg.label}</Badge>}
      </div>

      {/* Rejection / Re-KYC banner */}
      {kyc.rejectionReason && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-start gap-2">
          <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{kyc.rejectionReason}</p>
        </div>
      )}

      {/* Escalation notice */}
      {escalatedFrom && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-700">Approval escalated — {escalatedFrom} was vacant. Escalated to next approver.</p>
        </div>
      )}

      {/* Approval Timeline — hidden for approved outlets (no longer actionable) */}
      {!isApproved && <ApprovalTimeline kyc={kyc} />}

      {/* Approve / Reject actions for SO and ASM */}
      {canApprove && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-amber-700 font-medium mb-3">
              This KYC requires your review before it proceeds to Gifsy validation.
            </p>
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1 border-red-300 text-red-600 hover:bg-red-50"
                onClick={() => setShowRejectModal(true)}
                loading={approving}
              >
                <XCircle className="h-4 w-4" /> Reject
              </Button>
              <Button
                variant="primary"
                className="flex-1"
                onClick={handleApprove}
                loading={approving}
              >
                <CheckCircle className="h-4 w-4" /> Approve
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pending Gifsy notice */}
      {kyc.status === KYCStatus.PENDING_GIFSY && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-start gap-2">
          <Clock className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
          <p className="text-sm text-blue-700">Awaiting final validation by Gifsy. No action required from your side.</p>
        </div>
      )}

      {/* ─── Target Achievement (4A + 4B) ──────────────────────────────────────── */}
      {targetConfig && achievement && (
        <Card className="overflow-hidden">
          {/* Pace strip */}
          <div className={`h-1 ${pace.strip}`} />

          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Target className="h-4 w-4 text-[#16a34a]" /> {periodLabel} Targets
              </CardTitle>
              <div className="flex items-center gap-2">
                {monthPace.daysLeft > 0 && (
                  <span className={`text-[10px] font-semibold ${
                    monthPace.daysLeft <= 7 ? 'text-red-500' : monthPace.daysLeft <= 14 ? 'text-amber-600' : 'text-gray-400'
                  }`}>
                    {monthPace.daysLeft}d left
                  </span>
                )}
                <span className="text-[10px] text-gray-400">{targetConfig.geoName}</span>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-4 pb-4">
            {/* Hero: Monthly Target */}
            {heroParam && (() => {
              const achieved = achievement.achievements[heroParam.id] ?? 0;
              const pp  = pct(achieved, heroParam.target);
              const bar = pctBarColor(pp);
              const fmt = (n: number) => heroParam.unit === '₹L' ? `₹${n}L` : `${n} ${heroParam.unit}`;
              const remaining = Math.max(0, heroParam.target - achieved);
              return (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-800">Monthly Target</span>
                    <span className={`text-sm font-bold px-2.5 py-1 rounded-full ${pctBg(pp)}`}>{pp}%</span>
                  </div>
                  <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${bar} transition-all`} style={{ width: `${Math.min(pp, 100)}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">{fmt(achieved)} achieved</span>
                    <span className="text-gray-400">Target: {fmt(heroParam.target)}</span>
                  </div>
                  {remaining > 0 && (
                    <p className="text-[10px] font-semibold text-indigo-600 bg-indigo-50 px-2 py-1 rounded-lg">
                      {fmt(remaining)} remaining to hit target
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Other params in 2-col KPI grid */}
            {otherParams.length > 0 && (
              <div className="grid grid-cols-2 gap-2.5">
                {otherParams.map(p => {
                  const achieved = achievement.achievements[p.id] ?? 0;
                  const pp  = pct(achieved, p.target);
                  const bar = pctBarColor(pp);
                  const fmt = (n: number) => p.unit === '₹L' ? `₹${n}L` : `${n} ${p.unit}`;
                  return (
                    <div key={p.id} className="bg-gray-50 rounded-xl p-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] font-medium text-gray-600 leading-tight truncate">{p.label}</span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 ${pctBg(pp)}`}>{pp}%</span>
                      </div>
                      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                        <div className={`h-full rounded-full ${bar} transition-all`} style={{ width: `${Math.min(pp, 100)}%` }} />
                      </div>
                      <p className="text-[10px] text-gray-500">{fmt(achieved)} / {fmt(p.target)}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Pace badge */}
            <div className={`flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1.5 rounded-lg ${pace.bg} ${pace.text}`}>
              <TrendingUp className="h-3 w-3 shrink-0" />
              {pace.label} · {monthPace.timePct}% of {periodLabel} elapsed
              {monthPace.daysLeft > 0 && ` · ${monthPace.daysLeft} days left`}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Partner + Document + Bank details (collapsible for all, default closed) ── */}
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <button
          onClick={() => setDetailsOpen(!detailsOpen)}
          className="w-full flex items-center justify-between px-4 py-3.5 bg-gray-50 hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-gray-400" />
            <span className="text-sm font-semibold text-gray-600">Store Information</span>
            <span className="text-[10px] text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded-full">
              KYC · {kyc.documents.length} docs{kyc.bankName ? ' · Bank' : ''}
            </span>
          </div>
          <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform duration-200 ${detailsOpen ? 'rotate-180' : ''}`} />
        </button>

        {detailsOpen && (
          <div className="p-4 space-y-4 bg-white">
            {/* Partner Details */}
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Partner Details</p>
              <div className="space-y-2.5">
                {[
                  { icon: <User className="h-3.5 w-3.5" />,   label: 'Name',    value: kyc.partnerName },
                  { icon: <Phone className="h-3.5 w-3.5" />,  label: 'Mobile',  value: `+91 ${kyc.mobile}` },
                  { icon: <MapPin className="h-3.5 w-3.5" />, label: 'Address', value: `${kyc.address}, ${kyc.city}, ${kyc.state}` },
                ].map(row => (
                  <div key={row.label} className="flex items-start gap-2">
                    <span className="text-gray-400 mt-0.5 shrink-0">{row.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400">{row.label}</p>
                      <p className="text-sm text-gray-800">{row.value}</p>
                    </div>
                  </div>
                ))}
                {kyc.outletCode && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">Outlet Code</span>
                    <span data-testid="kyc-store-outlet-code" className="text-sm font-mono text-gray-800">{kyc.outletCode}</span>
                  </div>
                )}
                {kyc.gstNumber && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">GST</span>
                    <span data-testid="kyc-store-gst" className="text-sm font-mono text-gray-800">{kyc.gstNumber}</span>
                  </div>
                )}
                {kyc.panNumber && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">PAN</span>
                    <span data-testid="kyc-store-pan" className="text-sm font-mono text-gray-800">{kyc.panNumber}</span>
                  </div>
                )}
                <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full ${
                  kyc.partnerClass === 'GOLD' ? 'bg-amber-50 text-amber-700' :
                  kyc.partnerClass === 'SILVER' ? 'bg-gray-100 text-gray-600' : 'bg-orange-50 text-orange-700'
                }`}>{kyc.partnerClass} Tier</span>
              </div>
            </div>

            <div className="border-t border-gray-100" />

            {/* Outlet Photos */}
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Outlet Photos</p>
              <button
                data-testid="outlet-photo-view-btn"
                onClick={() => setPhotoLightboxOpen(true)}
                className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <Camera className="h-4 w-4 text-gray-400" />
                View Photos
              </button>
              {photoLightboxOpen && (
                <div data-testid="outlet-photo-lightbox" className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center" onClick={() => setPhotoLightboxOpen(false)}>
                  <div className="bg-white rounded-xl p-6 text-center">
                    <p className="text-sm text-gray-600">No photos available in demo mode.</p>
                    <button className="mt-3 text-xs text-gray-400 underline" onClick={() => setPhotoLightboxOpen(false)}>Close</button>
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-gray-100" />

            {/* Document Checklist */}
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Documents</p>
              <div className="space-y-1.5">
                {kyc.documents.map(doc => (
                  <div key={doc.label} className="flex items-center justify-between py-0.5">
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
            </div>

            {/* Bank Details */}
            {kyc.bankName && (
              <>
                <div className="border-t border-gray-100" />
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Bank Details</p>
                  <div className="space-y-1.5">
                    {[
                      { label: 'Bank',    value: kyc.bankName       },
                      { label: 'Account', value: kyc.accountNumber  },
                      { label: 'IFSC',    value: kyc.ifscCode       },
                    ].map(row => (
                      <div key={row.label} className="flex items-center justify-between">
                        <span className="text-xs text-gray-400">{row.label}</span>
                        <span className="text-sm font-medium text-gray-800 font-mono">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Submit for review (draft state) */}
      {(kyc.status === KYCStatus.PENDING || kyc.status === KYCStatus.SUBMITTED) && (
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-gray-500 mb-3">
              Once all documents are collected, submit for the first-level approval.
            </p>
            <Button variant="primary" className="w-full" loading={submitting} onClick={handleSubmitForReview}>
              Submit for Review
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Fix & Resubmit — shown only for REJECTED */}
      {kyc.status === KYCStatus.REJECTED && (
        <Card className="border-red-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-red-700">Fix & Resubmit</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pb-4">
            <p className="text-xs text-gray-500">Upload corrected documents and resubmit for review.</p>
            <div className="space-y-2">
              {kyc.documents.map(doc => (
                <div key={doc.label} className="flex items-center gap-3 py-1">
                  <span className="text-sm text-gray-700 flex-1">{doc.label}</span>
                  <input
                    type="file"
                    accept={CAMERA_ONLY_DOCS.has(doc.label) ? 'image/*' : 'image/*,application/pdf'}
                    {...(CAMERA_ONLY_DOCS.has(doc.label) ? { capture: 'environment' as const } : {})}
                    className="text-xs text-gray-500"
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        setResubmitFiles((prev) => [...prev, e.target.files![0]]);
                      }
                    }}
                  />
                </div>
              ))}
            </div>
            <Button
              variant="primary"
              className="w-full"
              disabled={resubmitFiles.length === 0}
              loading={resubmitting}
              onClick={handleResubmit}
            >
              Resubmit for Review
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Past Performance */}
      {(PAST_PERF[resolvedId]?.length ?? 0) > 0 && (
        <div data-testid="past-performance" className="space-y-2">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-0.5">Past Performance</p>
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <div className="flex items-end gap-2 h-20">
              {PAST_PERF[resolvedId].map((m) => (
                <div key={m.month} data-testid="perf-month-bar" className="flex-1 flex flex-col items-center gap-1">
                  <div
                    className={`w-full rounded-t-sm ${m.achievePct >= 100 ? 'bg-emerald-400' : m.achievePct >= 90 ? 'bg-amber-400' : 'bg-red-400'}`}
                    style={{ height: `${Math.round((Math.min(m.achievePct, 100) / 100) * 64)}px` }}
                  />
                  <span className="text-[9px] text-gray-400">{m.month}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-0.5">Quick Actions</p>
        {(() => {
          const ledgerLabel = settings.salesApp?.ledgerLabel ?? 'View Points Ledger';
          const showRedeem  = !(settings.salesApp?.redeemGiftWholesalerOnly && kyc.outletType !== 'WHOLESALER');
          const showVis     = settings.visibilityPhotoEnabled === true;
          const actions = [
            { href: `/sales/kyc/${id}/ledger`,         icon: <BookOpen       className="h-4 w-4 text-blue-500" />,    bg: 'bg-blue-50',       title: ledgerLabel,              sub: 'Transaction history & balance',             show: true      },
            { href: `/sales/catalogue?outletId=${id}`, icon: <Gift           className="h-4 w-4 text-purple-500" />,  bg: 'bg-purple-50',     title: 'Redeem Gift for Outlet', sub: 'Browse catalogue & redeem with OTP',        show: showRedeem },
            { href: '/sales/visibility',               icon: <Camera         className="h-4 w-4 text-[#16a34a]" />,   bg: 'bg-[#16a34a]/10',  title: 'Submit Visibility Photo',sub: 'Earn points for branding photos',           show: showVis    },
            { href: '/sales/support',                  icon: <HeadphonesIcon className="h-4 w-4 text-rose-500" />,    bg: 'bg-rose-50',       title: 'Raise Support Ticket',  sub: 'Report an issue on behalf of this outlet',  show: true      },
          ];
          return actions.filter(a => a.show).map(action => (
            <Link key={action.href} href={action.href} className="flex items-center gap-3 p-4 bg-white rounded-xl border border-gray-200 hover:bg-gray-50 transition-colors">
              <div className={`p-2 ${action.bg} rounded-lg`}>{action.icon}</div>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{action.title}</p>
                <p className="text-xs text-gray-500">{action.sub}</p>
              </div>
              <ChevronRight className="h-4 w-4 text-gray-300" />
            </Link>
          ));
        })()}
      </div>

      {/* Rejection modal */}
      {showRejectModal && (
        <RejectionModal onConfirm={handleReject} onCancel={() => setShowRejectModal(false)} />
      )}
    </div>
  );
}
