'use client';

import { use, useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Building2, Phone, MapPin, User,
  CheckCircle, XCircle, Clock, AlertTriangle,
  Camera, ChevronRight, ChevronDown,
  BookOpen, Gift, HeadphonesIcon, ThumbsUp,
  ShoppingCart,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KYCStatus, type ApprovalEvent, type KYCSubmitterRole } from '@/types';
import { getRole } from '@/lib/sales-role';
import { useGifsySettings } from '@/lib/gifsy-settings';

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
  outletId?: string;
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

/** Map the backend KycStatusHistory rows (returned by GET /v1/kyc/:id) into the
 *  ApprovalEvent shape the timeline reads. No fabricated names — `by`/`role` come
 *  from the persisted approver role (history.metadata.approverRole) when present. */
interface ApiStatusHistory {
  toStatus: string;
  createdAt: string;
  notes?: string | null;
  metadata?: { stage?: string; approverRole?: string } | null;
}
const REJECT_TO_STATUSES = new Set(['REJECTED', 'RESUBMISSION_REQUIRED', 'RE_UPLOAD_REQUIRED']);
const APPROVAL_TO_STATUSES = new Set([
  'REJECTED', 'RESUBMISSION_REQUIRED', 'RE_UPLOAD_REQUIRED',
  'PENDING_ASM_APPROVAL', 'PENDING_GIFSY', 'APPROVED',
]);
function mapStatusHistory(history: ApiStatusHistory[]): ApprovalEvent[] {
  return history
    .filter((h) => APPROVAL_TO_STATUSES.has(h.toStatus))
    .map((h) => {
      const rejected = REJECT_TO_STATUSES.has(h.toStatus);
      const stage: ApprovalEvent['stage'] =
        h.metadata?.stage === 'GIFSY' || h.toStatus === 'APPROVED' ? 'GIFSY' : 'FIRST_APPROVER';
      return {
        stage,
        action: (rejected ? 'REJECTED' : 'APPROVED') as ApprovalEvent['action'],
        by:    h.metadata?.approverRole ?? '',
        role:  h.metadata?.approverRole ?? '',
        timestamp: h.createdAt,
        remarks: h.notes ?? undefined,
      };
    })
    .reverse(); // backend returns newest-first; timeline reads chronologically
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
  const [kyc,     setKyc]     = useState<KYCDetail | null>(null);
  const [loadingKyc, setLoadingKyc] = useState(true);

  const [approving,         setApproving]         = useState(false);
  const [showRejectModal,   setShowRejectModal]   = useState(false);
  const [actionError,       setActionError]       = useState<string | null>(null);
  const [role,              setRoleState]         = useState<string>('SO');
  const [detailsOpen,       setDetailsOpen]       = useState(false);
  const [photoLightboxOpen, setPhotoLightboxOpen] = useState(false);
  // Settings are SERVER-sourced and reactive — reflects the tenant after /me hydrates.
  const settings = useGifsySettings();
  // Authoritative DB flag for the visibility workflow (TenantService.resolveVisibilityCaptureMode),
  // delivered via the server settings block (/me + /settings) so SALES roles can read it — the
  // /admin/settings/config endpoint is admin-only and would 403 for sales, defaulting wrongly.
  const captureMode = settings.visibilityCaptureMode ?? 'PHOTO_APPROVAL';

  useEffect(() => {
    setRoleState(getRole());
  }, []);

  /* ── Fetch KYC from API (reusable — re-run after approve/reject to reflect the
   *    authoritative persisted status + history, never an optimistic local guess) ── */
  const loadKyc = useCallback(async () => {
    setLoadingKyc(true);
    const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
    try {
      const r = await fetch(`/api/kyc/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await r.json();
      if (json.success && json.data?.submission) {
        const s = json.data.submission;
        setKyc({
          id:              s.id,
          outletId:        s.partner?.outlets?.[0]?.id ?? '',
          outletCode:      s.partner?.outlets?.[0]?.outletCode ?? '',
          partnerName:     s.user?.name                       ?? '',
          firmName:        s.partner?.businessName            ?? '',
          mobile:          s.user?.phone                      ?? '',
          address:         s.partner?.address                 ?? '',
          city:            s.partner?.city                    ?? '',
          state:           s.partner?.state                   ?? '',
          partnerClass:    '',
          status:          (s.status as KYCStatus)            ?? KYCStatus.SUBMITTED,
          submittedAt:     s.submittedAt                      ?? new Date().toISOString(),
          submittedByRole: (s.user?.role as KYCSubmitterRole) ?? 'SO',
          submittedByName: s.user?.name                       ?? '',
          rejectionReason: s.rejectionReason                  ?? undefined,
          gstNumber:       s.partner?.gstNumber,
          panNumber:       s.partner?.panNumber,
          bankName:        s.partner?.bankName,
          accountNumber:   s.partner?.bankAccountNumber,
          ifscCode:        s.partner?.ifscCode,
          documents:       (s.documents ?? []).map((d: { label: string; status?: string }) => ({
            label:  d.label,
            status: (d.status as 'uploaded' | 'missing' | 'verified') ?? 'uploaded',
          })),
          approvalHistory: mapStatusHistory(s.statusHistory ?? []),
        });
      }
    } catch {
      /* leave kyc null → the not-found UI renders */
    } finally {
      setLoadingKyc(false);
    }
  }, [id]);

  useEffect(() => { void loadKyc(); }, [loadKyc]);

  if (loadingKyc) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="text-sm text-gray-400">Loading…</span>
      </div>
    );
  }

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
    setActionError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
      const res = await fetch(`/api/kyc/${id}/first-approve`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        setActionError(json?.error ?? 'Approval failed. Please try again.');
        return;
      }
      await loadKyc(); // authoritative persisted status + history
    } catch {
      setActionError('Approval failed. Please check your connection and try again.');
    } finally {
      setApproving(false);
    }
  };

  const handleReject = async (remarks: string) => {
    setShowRejectModal(false);
    setApproving(true);
    setActionError(null);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('token') ?? '' : '';
      const res = await fetch(`/api/kyc/${id}/reject`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ reason: remarks }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.success === false) {
        setActionError(json?.error ?? 'Rejection failed. Please try again.');
        return;
      }
      await loadKyc(); // authoritative persisted status + history
    } catch {
      setActionError('Rejection failed. Please check your connection and try again.');
    } finally {
      setApproving(false);
    }
  };

  /* Re-entry: route the junior into the pre-filled new-KYC wizard (selects by outlet). */
  const isReEntry =
    kyc.status === KYCStatus.REJECTED ||
    kyc.status === KYCStatus.RESUBMISSION_REQUIRED ||
    kyc.status === KYCStatus.RE_KYC_REQUIRED;

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
              <p className="text-xs text-gray-500">{kyc.partnerName}</p>
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

      {/* Approval Timeline — hidden for approved outlets (no longer actionable) */}
      {!isApproved && <ApprovalTimeline kyc={kyc} />}

      {/* Approve / Reject actions for SO and ASM */}
      {canApprove && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-amber-700 font-medium mb-3">
              This KYC requires your review before it proceeds to Gifsy validation.
            </p>
            {actionError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
                {actionError}
              </p>
            )}
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

      {/* Edit & Resubmit — opens the pre-filled new-KYC wizard for the outlet.
          Shown for rejected / resubmission / re-KYC. The rejection remark banner
          above shows the reason first; the wizard pre-fills the prior entry. */}
      {isReEntry && (
        <Card className="border-red-200">
          <CardContent className="pt-4 pb-4 space-y-3">
            <p className="text-xs text-gray-500">
              Review the remark above, then re-open the KYC form pre-filled with the previous entry. Edit what&apos;s needed and resubmit.
            </p>
            <Link
              href={`/sales/kyc/new?outletId=${kyc.outletId ?? ''}`}
              className="block"
            >
              <Button variant="primary" className="w-full" disabled={!kyc.outletId}>
                Edit &amp; Resubmit KYC
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Quick actions */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide px-0.5">Quick Actions</p>
        {(() => {
          const ledgerLabel = settings.salesApp?.ledgerLabel ?? 'View Points Ledger';
          const showRedeem  = !(settings.salesApp?.redeemGiftWholesalerOnly && kyc.outletType !== 'WHOLESALER');
          // Visibility-photo action precedence: the authoritative DB flag (visibilityCaptureMode)
          // wins. The backend REJECTS photo upload unless the tenant is in PHOTO_APPROVAL mode, so
          // showing the action when the display-only visibilityPhotoEnabled disagrees would lead the
          // agent into a guaranteed backend rejection. Require BOTH: PHOTO_APPROVAL mode AND the
          // display flag — they can no longer contradict the backend.
          const showVis     = captureMode === 'PHOTO_APPROVAL' && settings.visibilityPhotoEnabled === true;
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
