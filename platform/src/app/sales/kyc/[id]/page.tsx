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
import { RejectionModal } from './RejectionModal';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

interface KYCDetail {
  id: string;
  partnerName: string;
  ownerName: string;
  firmName: string;
  outletName: string;
  outletPhone: string;
  mobile: string;
  address: string;
  city: string;
  state: string;
  pincode?: string;
  // KYC-captured geo. boardGeo is taken when the store-board photo is shot (the
  // outlet's physical location); paymentGeo when the cheque/UPI is captured.
  boardGeo?: { lat: number; lng: number } | null;
  paymentGeo?: { lat: number; lng: number } | null;
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
  upiId?: string;
  documents: KYCDoc[];
  photos: { label: string; url: string }[];
  approvalHistory: ApprovalEvent[];
}

/** A single uploaded KYC document, with a short-lived signed URL to open it. */
interface KYCDoc {
  id: string;
  documentType: string;
  label: string;
  status: 'pending' | 'verified' | 'rejected';
  viewUrl: string | null;
}

/** Friendly labels for the KycDocumentType enum (fallback: title-case the enum). */
const DOC_LABELS: Record<string, string> = {
  AADHAAR_FRONT: 'Aadhaar (Front)',
  AADHAAR_BACK: 'Aadhaar (Back)',
  PAN_CARD: 'PAN Card',
  GST_CERTIFICATE: 'GST Certificate',
  TRADE_LICENSE: 'Trade License',
  SHOP_ESTABLISHMENT: 'Shop & Establishment',
  BANK_PASSBOOK: 'Bank Passbook',
  CANCELLED_CHEQUE: 'Cancelled Cheque',
  SELFIE: 'Owner Photo',
  SIGNATURE: 'Signature',
  STORE_BOARD_PHOTO: 'Store Board Photo',
  SELF_DECLARATION: 'Self Declaration',
  OTHER: 'Other Document',
};
function docLabel(type: string): string {
  return DOC_LABELS[type] ?? type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The document types that are store/owner PHOTOS (rendered as images, not list rows). */
const PHOTO_DOC_TYPES = new Set(['STORE_BOARD_PHOTO', 'SELFIE']);

/** Map a raw KycDocument row (id + documentType + status + viewUrl) into the view shape. */
function mapDoc(d: { id?: string; documentType: string; status?: string; viewUrl?: string | null }): KYCDoc {
  const raw = (d.status ?? 'PENDING').toUpperCase();
  return {
    id: d.id ?? d.documentType,
    documentType: d.documentType,
    label: docLabel(d.documentType),
    status: raw === 'VERIFIED' ? 'verified' : raw === 'REJECTED' ? 'rejected' : 'pending',
    viewUrl: d.viewUrl ?? null,
  };
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
    ownerName?: string;
    gstNumber?: string;
    panNumber?: string;
    address: string;
    city: string;
    state: string;
    bankName?: string;
    bankAccountNumber?: string;
    ifscCode?: string;
    upiId?: string;
    phone?: string;
    outlets?: { id: string; name: string; outletCode: string; phone?: string;
      addressLine1?: string | null; addressLine2?: string | null;
      city?: string | null; state?: string | null; pincode?: string | null }[];
  };
  documents?: { id?: string; documentType: string; status?: string; viewUrl?: string | null }[];
}

/** Mimes safe to RENDER in a top-level tab. A doc's mime is client-supplied at upload,
 *  so anything else (e.g. image/svg+xml or text/html) is opened as octet-stream — the
 *  browser DOWNLOADS it instead of rendering, preventing stored-XSS via a malicious
 *  "document" opened in our origin. */
const SAFE_RENDER_MIMES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
]);

/** Open a KYC document in a new tab. The backend inlines docs as `data:` URLs (private
 *  GCS objects, K12), and modern browsers BLOCK opening a `data:` URL as a top-level
 *  tab — "View" just showed a blank page. Convert it to a `blob:` URL (allowed). */
function openDocument(viewUrl: string): void {
  if (!viewUrl) return;
  if (viewUrl.startsWith('data:')) {
    try {
      const comma = viewUrl.indexOf(',');
      const rawMime = viewUrl.slice(5, viewUrl.indexOf(';')).toLowerCase();
      // Only render known-safe types inline; otherwise download (no script execution).
      const mime = SAFE_RENDER_MIMES.has(rawMime) ? rawMime : 'application/octet-stream';
      const bin = atob(viewUrl.slice(comma + 1));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60_000); // let the tab load, then free
      return;
    } catch {
      /* fall through */
    }
  }
  // Non-data URLs: only follow http(s) (never javascript:/other schemes).
  if (/^https?:\/\//i.test(viewUrl)) window.open(viewUrl, '_blank', 'noopener,noreferrer');
}

/** Coerce a KYC-captured lat/lng pair (Prisma Decimal → JSON string) into numbers.
 *  Returns null unless BOTH are present and finite (a half-captured geo is not a point). */
function parseGeo(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln)) return null;
  return { lat: la, lng: ln };
}

function mapApiSalesKYC(s: ApiSalesKYC): KYCDetail {
  // Address lives on the OUTLET (captured at KYC), not ChannelPartner.
  const o = s.partner.outlets?.[0];
  return {
    id: s.id,
    partnerName: s.user.name,
    ownerName: s.partner.ownerName ?? '',
    firmName: s.partner.businessName,
    outletName:  o?.name  ?? s.partner.businessName ?? '',
    outletPhone: o?.phone ?? s.partner.phone        ?? '',
    mobile: s.user.phone,
    address: [o?.addressLine1, o?.addressLine2].filter(Boolean).join(', '),
    city: o?.city ?? '',
    state: o?.state ?? '',
    pincode: o?.pincode ?? '',
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
    upiId: s.partner.upiId,
    documents: (s.documents ?? []).map(mapDoc),
    photos: (s.documents ?? [])
      .filter(d => PHOTO_DOC_TYPES.has(d.documentType) && d.viewUrl)
      .map(d => ({ label: docLabel(d.documentType), url: d.viewUrl as string })),
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
  [KYCStatus.RE_UPLOAD_REQUIRED]:    { variant: 'danger',  label: 'Re-upload Required' },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger',  label: 'Re-upload Required' },
  [KYCStatus.RE_KYC_REQUIRED]:       { variant: 'warning', label: 'Re-KYC Required'   },
};

const docStatusColor: Record<string, string> = {
  verified: 'text-emerald-600',
  pending:  'text-amber-600',
  rejected: 'text-red-500',
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
  const [photoLightboxIndex, setPhotoLightboxIndex] = useState<number | null>(null);
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
    try {
      const r = await fetch(`/api/kyc/${id}`);
      const json = await r.json();
      if (json.success && json.data?.submission) {
        const s = json.data.submission;
        setKyc({
          id:              s.id,
          outletId:        s.partner?.outlets?.[0]?.id ?? '',
          outletCode:      s.partner?.outlets?.[0]?.outletCode ?? '',
          // outletType.code (SSS/WHOLESALER/SUB_STOCKIST) gates the "Redeem for Outlet"
          // action when the tenant restricts redemption to wholesalers
          // (settings.salesApp.redeemGiftWholesalerOnly). Read from the relation the
          // detail endpoint now selects — without it the gate sees `undefined` and
          // hides redeem for every outlet, even wholesalers.
          outletType:      s.partner?.outlets?.[0]?.outletType?.code ?? undefined,
          partnerName:     s.user?.name                       ?? '',
          // OWNER/contact-person name — captured in the KYC form, validated by the
          // Gifsy reviewer against the submitted PAN/Aadhaar. Distinct from the rep
          // (partnerName/submittedByName) and from the store/outlet name (title).
          ownerName:       s.partner?.ownerName               ?? '',
          firmName:        s.partner?.businessName            ?? '',
          // Identity = the OUTLET (name/phone), not the rep. submittedByName below stays the rep.
          outletName:      s.partner?.outlets?.[0]?.name      ?? s.partner?.businessName ?? '',
          outletPhone:     s.partner?.outlets?.[0]?.phone     ?? s.partner?.phone        ?? '',
          mobile:          s.user?.phone                      ?? '',
          // Address lives on the OUTLET (captured at KYC), not ChannelPartner.
          address:         [s.partner?.outlets?.[0]?.addressLine1, s.partner?.outlets?.[0]?.addressLine2].filter(Boolean).join(', '),
          city:            s.partner?.outlets?.[0]?.city       ?? '',
          state:           s.partner?.outlets?.[0]?.state      ?? '',
          pincode:         s.partner?.outlets?.[0]?.pincode    ?? '',
          // Geo captured during KYC (lives on the submission, not the outlet).
          boardGeo:        parseGeo(s.boardPhotoLat, s.boardPhotoLng),
          paymentGeo:      parseGeo(s.paymentLat, s.paymentLng),
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
          upiId:           s.partner?.upiId,
          documents:       (s.documents ?? []).map(mapDoc),
          // Store/owner photos are rendered as images; everything else lists as a doc row.
          photos:          (s.documents ?? [])
            .filter((d: { documentType: string; viewUrl?: string | null }) =>
              PHOTO_DOC_TYPES.has(d.documentType) && d.viewUrl)
            .map((d: { documentType: string; viewUrl?: string | null }) => ({
              label: docLabel(d.documentType),
              url:   d.viewUrl as string,
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
      const res = await fetch(`/api/kyc/${id}/first-approve`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const res = await fetch(`/api/kyc/${id}/reject`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
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
    kyc.status === KYCStatus.RE_UPLOAD_REQUIRED ||
    kyc.status === KYCStatus.RESUBMISSION_REQUIRED ||
    kyc.status === KYCStatus.RE_KYC_REQUIRED;

  /* ── "Redeem for Outlet" gate ──────────────────────────────────────────────
     Owner decision: the redeem-on-behalf action lives on the OUTLET DETAIL view
     (this page, reached by tapping an outlet), surfaced prominently — NOT on the
     outlet list and NOT as a bottom-nav tab.

     showRedeem hides redeem only when the tenant restricts it to wholesalers
     (settings.salesApp.redeemGiftWholesalerOnly === true) AND this outlet is not a
     wholesaler. A normal redeemable outlet (wholesaler, OR any outlet when the
     restriction is off) shows the button. outletType now comes from the API (the
     detail endpoint selects outletType.code) so the gate no longer collapses to
     "always hidden" from an undefined type. */
  const showRedeem =
    !(settings.salesApp?.redeemGiftWholesalerOnly && kyc.outletType !== 'WHOLESALER');

  return (
    <div className="space-y-4 fade-in">
      {/* Back + header */}
      <div className="flex items-center gap-3">
        <Link href="/sales/kyc" className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4 text-gray-600" />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-bold text-gray-900 truncate">{kyc.outletName || kyc.firmName}</h1>
          <div className="flex items-center gap-2 flex-wrap mt-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-xs text-gray-500">+91 {kyc.outletPhone}</p>
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

      {/* Redeem for Outlet — PRIMARY action, surfaced prominently on the outlet detail
          view (owner decision: only after a rep navigates INTO an outlet). Gated by the
          tenant's wholesaler-only redemption setting; the same gate also drives the
          Quick-Actions entry below (kept in sync, no duplicate card). */}
      {showRedeem && (
        <Link href={`/sales/catalogue?outletId=${id}`} className="block" data-testid="redeem-for-outlet">
          <Button variant="primary" className="w-full justify-center gap-2 py-3 text-sm">
            <Gift className="h-4 w-4" />
            Redeem for Outlet
          </Button>
        </Link>
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
              KYC · {kyc.documents.length} docs{(kyc.bankName || kyc.upiId) ? ' · Payment' : ''}
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
                  { icon: <User className="h-3.5 w-3.5" />,   label: 'Owner Name', value: kyc.ownerName },
                  { icon: <Phone className="h-3.5 w-3.5" />,  label: 'Mobile',  value: `+91 ${kyc.outletPhone}` },
                  { icon: <MapPin className="h-3.5 w-3.5" />, label: 'Address', value: [kyc.address, kyc.city, kyc.state, kyc.pincode].filter(Boolean).join(', ') || '—' },
                ].map(row => (
                  <div key={row.label} className="flex items-start gap-2">
                    <span className="text-gray-400 mt-0.5 shrink-0">{row.icon}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400">{row.label}</p>
                      <p className="text-sm text-gray-800">{row.value}</p>
                    </div>
                  </div>
                ))}
                {(() => {
                  // KYC-captured geo: prefer the store-board location (the outlet's
                  // physical spot), fall back to the payment-capture location.
                  const geo = kyc.boardGeo ?? kyc.paymentGeo;
                  return geo ? (
                    <div className="flex items-start gap-2" data-testid="kyc-store-location">
                      <span className="text-gray-400 mt-0.5 shrink-0"><MapPin className="h-3.5 w-3.5" /></span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-gray-400">Location (lat, long)</p>
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${geo.lat},${geo.lng}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-mono text-emerald-700 underline decoration-dotted underline-offset-2 hover:text-emerald-800"
                        >
                          {geo.lat.toFixed(6)}, {geo.lng.toFixed(6)}
                        </a>
                      </div>
                    </div>
                  ) : null;
                })()}
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
              </div>
            </div>

            <div className="border-t border-gray-100" />

            {/* Outlet Photos — real store-board + owner photos (signed GCS URLs). */}
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Outlet Photos</p>
              {kyc.photos.length > 0 ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {kyc.photos.map((photo, i) => (
                      <button
                        key={photo.url}
                        data-testid="outlet-photo-thumb"
                        onClick={() => setPhotoLightboxIndex(i)}
                        className="relative aspect-video rounded-lg overflow-hidden border border-gray-200 bg-gray-50 group"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={photo.url} alt={photo.label} className="w-full h-full object-cover group-hover:opacity-90 transition-opacity" />
                        <span className="absolute bottom-0 inset-x-0 bg-black/55 text-white text-[10px] font-medium px-1.5 py-0.5 text-left truncate">{photo.label}</span>
                      </button>
                    ))}
                  </div>
                  {photoLightboxIndex !== null && kyc.photos[photoLightboxIndex] && (
                    <div data-testid="outlet-photo-lightbox" className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4" onClick={() => setPhotoLightboxIndex(null)}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={kyc.photos[photoLightboxIndex].url} alt={kyc.photos[photoLightboxIndex].label} className="max-w-full max-h-[80vh] rounded-lg object-contain" />
                      <p className="text-white text-sm mt-3">{kyc.photos[photoLightboxIndex].label}</p>
                      <button className="mt-2 text-xs text-gray-300 underline" onClick={() => setPhotoLightboxIndex(null)}>Close</button>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-400">
                  <Camera className="h-4 w-4 text-gray-300" />
                  No photos uploaded
                </div>
              )}
            </div>

            <div className="border-t border-gray-100" />

            {/* Document Checklist */}
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Documents</p>
              <div className="space-y-1.5">
                {(() => {
                  // Photos are rendered above as images; the checklist lists the rest.
                  const docRows = kyc.documents.filter(d => !PHOTO_DOC_TYPES.has(d.documentType));
                  if (docRows.length === 0) return <p className="text-xs text-gray-400">No documents uploaded</p>;
                  return docRows.map(doc => (
                  <div key={doc.id} className="flex items-center justify-between py-0.5 gap-2">
                    <span className="text-sm text-gray-700 truncate">{doc.label}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {doc.viewUrl && (
                        <button
                          type="button"
                          onClick={() => openDocument(doc.viewUrl as string)}
                          data-testid="kyc-doc-view-link"
                          className="text-xs text-blue-600 hover:underline"
                        >
                          View
                        </button>
                      )}
                      <span className={`text-xs font-medium capitalize ${docStatusColor[doc.status]}`}>
                        {doc.status === 'verified' && <CheckCircle className="h-3.5 w-3.5 inline mr-1" />}
                        {doc.status === 'pending'  && <Clock       className="h-3.5 w-3.5 inline mr-1" />}
                        {doc.status === 'rejected' && <XCircle     className="h-3.5 w-3.5 inline mr-1" />}
                        {doc.status}
                      </span>
                    </div>
                  </div>
                  ));
                })()}
              </div>
            </div>

            {/* Payment Details — the KYC form captures bank OR UPI; show whichever was given. */}
            {(kyc.bankName || kyc.upiId) && (
              <>
                <div className="border-t border-gray-100" />
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Payment Details</p>
                  <div className="space-y-1.5">
                    {[
                      { label: 'Bank',    value: kyc.bankName       },
                      { label: 'Account', value: kyc.accountNumber  },
                      { label: 'IFSC',    value: kyc.ifscCode       },
                      { label: 'UPI ID',  value: kyc.upiId          },
                    ].filter(row => row.value).map(row => (
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
          // "Redeem for Outlet" is surfaced as the PROMINENT primary button above
          // (same showRedeem gate), so it is intentionally NOT repeated in this list.
          // Visibility-photo action precedence: the authoritative DB flag (visibilityCaptureMode)
          // wins. The backend REJECTS photo upload unless the tenant is in PHOTO_APPROVAL mode, so
          // showing the action when the display-only visibilityPhotoEnabled disagrees would lead the
          // agent into a guaranteed backend rejection. Require BOTH: PHOTO_APPROVAL mode AND the
          // display flag — they can no longer contradict the backend.
          const showVis     = settings.visibilityEnabled === true && captureMode === 'PHOTO_APPROVAL' && settings.visibilityPhotoEnabled === true;
          const actions = [
            { href: `/sales/kyc/${id}/ledger`,         icon: <BookOpen       className="h-4 w-4 text-blue-500" />,    bg: 'bg-blue-50',       title: ledgerLabel,              sub: 'Transaction history & balance',             show: true      },
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
