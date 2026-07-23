'use client';

import { use, useState, useEffect, useCallback, type ReactNode } from 'react';
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
import { hasReKycFlags, isReKycActionable, reKycRemarks, flaggedLabels, flaggedDocTypes, type ReKycFlags } from '@/lib/rekyc-fields';
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
  // The payout method the outlet-master mandates for this outlet — lets the approver
  // verify the rep captured the required type (BANK / UPI / ANY = rep's choice).
  requiredPaymentType?: 'BANK' | 'UPI' | 'ANY';
  status: KYCStatus;
  submittedAt: string;
  submittedByRole: KYCSubmitterRole;
  submittedByName: string;
  lastOrderDate?: string;
  rejectionReason?: string;
  // The submitting rep declared the shop board name and the address-proof name do not
  // match (and, for waiver-enabled tenants, the address proof upload was skipped).
  addressNameMismatch?: boolean;
  // Admin's per-field re-KYC request (bulk-upload or reviewer flagged). Drives the
  // amber re-KYC banner + re-entry even when status stays APPROVED.
  reKycFlags?: ReKycFlags;
  gstNumber?: string;
  panNumber?: string;
  bankName?: string;
  accountNumber?: string;
  ifscCode?: string;
  upiId?: string;
  // Re-KYC staged identity/payout changes (proposed vs current), or undefined when none.
  proposedChanges?: ProposedChanges;
  documents: KYCDoc[];
  photos: { label: string; url: string; documentType: string }[];
  approvalHistory: ApprovalEvent[];
}

/** A single uploaded KYC document, with a short-lived signed URL to open it. */
interface KYCDoc {
  id: string;
  documentType: string;
  label: string;
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

/** Friendly label for the outlet-mandated payout method (from the outlet master). */
const REQUIRED_PAYMENT_LABELS: Record<string, string> = {
  BANK: 'Bank account',
  UPI: 'UPI',
  ANY: "Any (rep's choice)",
};

/** Map a raw KycDocument row (id + documentType + viewUrl) into the view shape.
 *  NOTE: the per-document `status` is intentionally dropped — no workflow ever advances
 *  KycDocument.status off its PENDING default, so a status tag ("Pending") on an
 *  already-approved outlet was misleading noise. Approval is tracked at the submission
 *  level (KYC status), not per document. */
function mapDoc(d: { id?: string; documentType: string; viewUrl?: string | null }): KYCDoc {
  return {
    id: d.id ?? d.documentType,
    documentType: d.documentType,
    label: docLabel(d.documentType),
    viewUrl: d.viewUrl ?? null,
  };
}

/* ─── API types & mapping (leaderboard pattern) ─────────────────────────────── */

interface ApiSalesKYC {
  id: string;
  status: string;
  submittedAt: string;
  rejectionReason?: string | null;
  reKycFlags?: ReKycFlags;
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
    bankAccountHolder?: string;
    ifscCode?: string;
    upiId?: string;
    paymentMode?: string;
    phone?: string;
    outlets?: { id: string; name: string; outletCode: string; phone?: string;
      addressLine1?: string | null; addressLine2?: string | null;
      city?: string | null; state?: string | null; pincode?: string | null }[];
  };
  // Re-KYC (stage-at-approval): the PROPOSED (new) identity/payout values, applied to the
  // live partner only at Gifsy approval. Present ONLY for a re-KYC that staged changes.
  proposedPartner?: {
    businessName?: string | null; ownerName?: string | null; phone?: string | null;
    gstNumber?: string | null; panNumber?: string | null;
    bankName?: string | null; bankAccountNumber?: string | null; bankAccountHolder?: string | null;
    ifscCode?: string | null; upiId?: string | null; paymentMode?: string | null;
    // Outlet address is staged the same way and applied to the live outlet only at approval.
    addressLine1?: string | null; addressLine2?: string | null;
    city?: string | null; state?: string | null; pincode?: string | null;
  } | null;
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

/** Convert a KYC document's inlined `data:` URL to a `blob:` URL for in-page preview.
 *  PDFs need an <iframe> and Chrome blocks `data:` URLs there; images work in <img>
 *  either way but blob keeps it uniform. Returns the blob URL + resolved (safe) mime,
 *  or null for a non-data / undecodable URL. The caller must revoke the blob URL. */
function dataUrlToBlob(viewUrl: string): { url: string; mime: string } | null {
  if (!viewUrl.startsWith('data:')) return null;
  try {
    const comma = viewUrl.indexOf(',');
    const rawMime = viewUrl.slice(5, viewUrl.indexOf(';')).toLowerCase();
    const mime = SAFE_RENDER_MIMES.has(rawMime) ? rawMime : 'application/octet-stream';
    const bin = atob(viewUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { url: URL.createObjectURL(new Blob([bytes], { type: mime })), mime };
  } catch {
    return null;
  }
}

/** Coerce a KYC-captured lat/lng pair (Prisma Decimal → JSON string) into numbers.
 *  Returns null unless BOTH are present and finite (a half-captured geo is not a point). */
function parseGeo(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln)) return null;
  return { lat: la, lng: ln };
}

/* ─── Re-KYC proposed-change diff (stage-at-approval) ─────────────────────────── */

/** Identity/payout scalars a re-KYC can stage on `proposedPartner`, plus the synthetic
 *  `address` (composed from the staged outlet address components — see computeAddressChange). */
type ProposedFieldKey =
  | 'businessName' | 'ownerName' | 'phone' | 'gstNumber' | 'panNumber'
  | 'bankName' | 'bankAccountNumber' | 'bankAccountHolder' | 'ifscCode' | 'upiId' | 'paymentMode'
  | 'address';

interface ProposedFieldChange { proposed: string; current: string }
type ProposedChanges = Partial<Record<ProposedFieldKey, ProposedFieldChange>>;

/** Partner SCALAR keys diffed field-for-field (address is handled separately, below). */
const PROPOSED_FIELD_KEYS: Exclude<ProposedFieldKey, 'address'>[] = [
  'businessName', 'ownerName', 'phone', 'gstNumber', 'panNumber',
  'bankName', 'bankAccountNumber', 'bankAccountHolder', 'ifscCode', 'upiId', 'paymentMode',
];

const PROPOSED_FIELD_LABELS: Record<ProposedFieldKey, string> = {
  businessName: 'Firm Name', ownerName: 'Owner Name', phone: 'Mobile',
  gstNumber: 'GST', panNumber: 'PAN', bankName: 'Bank',
  bankAccountNumber: 'Account', bankAccountHolder: 'Account Holder',
  ifscCode: 'IFSC', upiId: 'UPI ID', paymentMode: 'Payment Mode', address: 'Address',
};

/** Outlet address components a re-KYC can stage on `proposedPartner`. The live values live
 *  on `partner.outlets[0]` (NOT the partner scalars) and are applied to the outlet at approval. */
const ADDRESS_PARTS = ['addressLine1', 'addressLine2', 'city', 'state', 'pincode'] as const;

/** Compose the page's single Address string (same order the rows render). */
function composeAddress(src: Record<string, unknown> | null | undefined): string {
  if (!src) return '';
  return ADDRESS_PARTS
    .map((k) => (typeof src[k] === 'string' ? (src[k] as string) : ''))
    .filter(Boolean)
    .join(', ');
}

/**
 * Diff the PROPOSED outlet address (staged on `proposedPartner`) against the current outlet
 * address (`partner.outlets[0]`). Absent proposed component = keep current (apply semantics),
 * so the proposed value is the OVERLAID full address the reviewer is approving. Address is not
 * PII-masked — rendered as-is. Returns undefined when no address staged / nothing changed.
 */
function computeAddressChange(
  currentOutlet: Record<string, unknown> | null | undefined,
  proposed: Record<string, unknown> | null | undefined,
): ProposedFieldChange | undefined {
  if (!proposed) return undefined;
  const staged = ADDRESS_PARTS.some((k) => typeof proposed[k] === 'string' && (proposed[k] as string).length > 0);
  if (!staged) return undefined;
  const overlaid: Record<string, unknown> = { ...(currentOutlet ?? {}) };
  for (const k of ADDRESS_PARTS) {
    const pv = proposed[k];
    if (typeof pv === 'string' && pv.length > 0) overlaid[k] = pv;
  }
  const proposedAddr = composeAddress(overlaid);
  const currentAddr = composeAddress(currentOutlet);
  if (proposedAddr && proposedAddr !== currentAddr) return { proposed: proposedAddr, current: currentAddr };
  return undefined;
}

/** Build the merged proposed-change map (scalar identity/payout + the outlet-address diff). */
function buildProposedChanges(
  partner: Record<string, unknown> | null | undefined,
  outlet: Record<string, unknown> | null | undefined,
  proposed: Record<string, unknown> | null | undefined,
): ProposedChanges | undefined {
  const scalar = computeProposedChanges(partner, proposed);
  const address = computeAddressChange(outlet, proposed);
  if (!scalar && !address) return undefined;
  return { ...(scalar ?? {}), ...(address ? { address } : {}) };
}

/**
 * Diff the PROPOSED (re-KYC-staged) identity/payout values against the still-live partner
 * values. Only a field whose proposed value is a non-empty string AND differs from the
 * current value is returned (absent/empty proposed key = "untouched", matching the backend
 * apply semantics). Both sides are already role-masked by the backend, so a sales reviewer
 * (masked to last-4) only sees a PAN/GST/account diff when the last-4 differs — the
 * always-visible fields (name/phone/bank/IFSC/UPI/holder/mode) diff in full. Returns
 * undefined when nothing changed / no re-KYC.
 */
function computeProposedChanges(
  partner: Record<string, unknown> | null | undefined,
  proposed: Record<string, unknown> | null | undefined,
): ProposedChanges | undefined {
  if (!proposed) return undefined;
  const out: ProposedChanges = {};
  for (const k of PROPOSED_FIELD_KEYS) {
    const pv = proposed[k];
    if (typeof pv !== 'string' || pv.length === 0) continue;
    const cv = partner?.[k];
    const cur = typeof cv === 'string' ? cv : '';
    if (pv !== cur) out[k] = { proposed: pv, current: cur };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Render a field value. When `change` is present the PROPOSED (new) value the reviewer is
 * approving is shown as the primary value with a "Proposed change" badge and the old value
 * beneath ("was: …"). When absent, the field renders exactly as before (no visual noise).
 */
function ProposedFieldValue({
  change, children,
}: { change?: ProposedFieldChange; children: ReactNode }): ReactNode {
  if (!change) return children;
  return (
    <span className="flex flex-col gap-0.5" data-testid="proposed-change">
      <span className="flex items-center gap-1.5 flex-wrap">
        <span className="text-gray-900 font-semibold">{change.proposed || '—'}</span>
        <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded-full whitespace-nowrap">
          Proposed change
        </span>
      </span>
      <span className="text-[10px] text-gray-400 font-sans">was: {change.current || '—'}</span>
    </span>
  );
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
    reKycFlags: s.reKycFlags ?? undefined,
    gstNumber: s.partner.gstNumber,
    panNumber: s.partner.panNumber,
    bankName: s.partner.bankName,
    accountNumber: s.partner.bankAccountNumber,
    ifscCode: s.partner.ifscCode,
    upiId: s.partner.upiId,
    proposedChanges: buildProposedChanges(
      s.partner as unknown as Record<string, unknown>,
      s.partner.outlets?.[0] as Record<string, unknown> | null | undefined,
      s.proposedPartner as Record<string, unknown> | null | undefined,
    ),
    documents: (s.documents ?? []).map(mapDoc),
    photos: (s.documents ?? [])
      .filter(d => PHOTO_DOC_TYPES.has(d.documentType) && d.viewUrl)
      .map(d => ({ label: docLabel(d.documentType), url: d.viewUrl as string, documentType: d.documentType })),
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
// A rejection-like transition (a bounce back to the rep). RE_KYC_REQUIRED is the
// admin re-KYC of an already-APPROVED outlet — it is NOT a fresh-cycle first-approver
// rejection, so it is classified separately below (stage GIFSY, action REJECTED) and
// must never mark the FIRST_APPROVER step as rejected.
const REJECT_TO_STATUSES = new Set([
  'REJECTED', 'RESUBMISSION_REQUIRED', 'RE_UPLOAD_REQUIRED', 'RE_KYC_REQUIRED',
]);
const APPROVAL_TO_STATUSES = new Set([
  'REJECTED', 'RESUBMISSION_REQUIRED', 'RE_UPLOAD_REQUIRED', 'RE_KYC_REQUIRED',
  'PENDING_ASM_APPROVAL', 'PENDING_GIFSY', 'APPROVED',
]);
function mapStatusHistory(history: ApiStatusHistory[]): ApprovalEvent[] {
  return history
    .filter((h) => APPROVAL_TO_STATUSES.has(h.toStatus))
    .map((h) => {
      const rejected = REJECT_TO_STATUSES.has(h.toStatus);
      // Stage source of truth is the persisted metadata.stage; fall back to the
      // toStatus (an APPROVED / RE_KYC_REQUIRED transition is always a GIFSY-stage
      // event) when a legacy row has no metadata.
      const stage: ApprovalEvent['stage'] =
        h.metadata?.stage === 'GIFSY' || h.metadata?.stage === 'FIRST_APPROVER'
          ? (h.metadata.stage as ApprovalEvent['stage'])
          : h.toStatus === 'APPROVED' || h.toStatus === 'RE_KYC_REQUIRED'
            ? 'GIFSY'
            : 'FIRST_APPROVER';
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
  [KYCStatus.DRAFT]:                 { variant: 'warning', label: 'Pending'            },
  [KYCStatus.SUBMITTED]:             { variant: 'info',    label: 'Submitted'          },
  [KYCStatus.UNDER_REVIEW]:          { variant: 'info',    label: 'Under Review'       },
  [KYCStatus.PENDING_SO_APPROVAL]:   { variant: 'warning', label: 'Awaiting SO'        },
  [KYCStatus.PENDING_ASM_APPROVAL]:  { variant: 'warning', label: 'Awaiting ASM'       },
  [KYCStatus.PENDING_GIFSY]:         { variant: 'info',    label: 'Awaiting Gifsy'     },
  [KYCStatus.REJECTED]:              { variant: 'danger',  label: 'Rejected'           },
  [KYCStatus.RE_UPLOAD_REQUIRED]:    { variant: 'danger',  label: 'Rejected'           },
  [KYCStatus.RESUBMISSION_REQUIRED]: { variant: 'danger',  label: 'Rejected'           },
  [KYCStatus.RE_KYC_REQUIRED]:       { variant: 'warning', label: 'Re-KYC Required'   },
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
  testid:   string;
}

/** Return the LATEST (newest) event for a stage. approvalHistory is chronological
 *  (oldest → newest, see mapStatusHistory), so a stale prior-cycle event (e.g. an
 *  original FIRST_APPROVER APPROVED that was later re-KYC'd and rejected) can never
 *  win over the current cycle's outcome — `findLast` returns the most recent. */
function latestForStage(kyc: KYCDetail, stage: ApprovalEvent['stage']): ApprovalEvent | undefined {
  return kyc.approvalHistory.findLast((e) => e.stage === stage);
}

/** Map a backend UserRole string (or an already-short label) to the short reviewer
 *  label shown in the stepper. SALES_ISR (XSR) never approves, so it is not a first
 *  approver — the map covers the roles that CAN be the first approver. */
const APPROVER_ROLE_LABEL: Record<string, string> = {
  SALES_SO: 'SO', SO: 'SO',
  SALES_ASM: 'ASM', ASM: 'ASM',
  SALES_STATE_HEAD: 'RSM', RSM: 'RSM',
  SALES_HO: 'HO', HO: 'HO',
};

/** Map a `PENDING_*_APPROVAL` first-approver status to the short reviewer label. */
const PENDING_STATUS_LABEL: Partial<Record<KYCStatus, string>> = {
  [KYCStatus.PENDING_SO_APPROVAL]:  'SO',
  [KYCStatus.PENDING_ASM_APPROVAL]: 'ASM',
  [KYCStatus.PENDING_RSM_APPROVAL]: 'RSM',
};

/**
 * Resolve the first-approver step label from the ACTUAL reviewer level, not the
 * submitter (the submitter cast to KYCSubmitterRole never equals the literal 'XSR',
 * and a binary XSR→SO/else→ASM split can't express the 6-level hierarchy with
 * vacant-level skipping). Resolution order:
 *   1. Awaiting first approval → derive from the PENDING_*_APPROVAL status, which is
 *      authoritative for WHO reviews now (also makes vacant-level skipping correct — a
 *      vacant SO routes to ASM → PENDING_ASM_APPROVAL → "ASM Review", and it can't be
 *      thrown off by a stale prior-cycle event after a vacancy change).
 *   2. Acted (PENDING_GIFSY / APPROVED / REJECTED — not in PENDING_STATUS_LABEL) → map
 *      the acted FIRST_APPROVER event's persisted approverRole.
 *   3. Fallback → "SO Review" (never renders a blank label).
 */
function firstApproverLabel(kyc: KYCDetail): string {
  const short =
    PENDING_STATUS_LABEL[kyc.status] ??
    APPROVER_ROLE_LABEL[latestForStage(kyc, 'FIRST_APPROVER')?.role ?? ''] ??
    'SO';
  return `${short} Review`;
}

/**
 * Build the 3-step Approval Status stepper (Submitted → first-approver → Gifsy).
 *
 * The stepper must reflect the CURRENT submission's true state, not a stale prior
 * cycle. Two guards make that hold:
 *   1. Use the LATEST event per stage (findLast), never the first — a re-KYC'd
 *      outlet has an old FIRST_APPROVER APPROVED before the current REJECTED.
 *   2. Key the Gifsy step off `kyc.status`. A first-approver rejection means the
 *      current cycle never reached Gifsy, so Gifsy stays PENDING regardless of any
 *      prior-cycle Gifsy event; only a live PENDING_GIFSY status (active) or an
 *      actual Gifsy-stage rejection/approval on the current record advances it.
 *
 * Per-case outcome (step2 = first-approver, step3 = Gifsy):
 *   PENDING_SO/ASM_APPROVAL  → step2 active,   step3 pending
 *   PENDING_GIFSY            → step2 complete,  step3 active
 *   APPROVED                 → step2 complete,  step3 complete
 *   first-approver rejection → step2 rejected,  step3 pending  (the bug case)
 *     (REJECTED / RE_UPLOAD_REQUIRED / RESUBMISSION_REQUIRED / RE_KYC_REQUIRED
 *      with the latest event's stage = FIRST_APPROVER, or no first-approver
 *      approval yet on the current cycle)
 *   Gifsy rejection          → step2 complete,  step3 rejected
 */
function buildTimeline(kyc: KYCDetail): TimelineStep[] {
  const stepFirstLabel     = firstApproverLabel(kyc);
  const firstApproverEvent = latestForStage(kyc, 'FIRST_APPROVER');
  const gifsyEvent         = latestForStage(kyc, 'GIFSY');

  // Is the current record in a rejected/bounced-back state, and by which stage?
  // The LATEST recorded event's stage disambiguates who rejected (first approver vs
  // Gifsy) — a fresh first-approver rejection has firstApproverEvent.action REJECTED
  // as the newest event; a Gifsy rejection has a GIFSY-stage REJECTED newest.
  const isRejectedStatus =
    kyc.status === KYCStatus.REJECTED ||
    kyc.status === KYCStatus.RE_UPLOAD_REQUIRED ||
    kyc.status === KYCStatus.RESUBMISSION_REQUIRED ||
    kyc.status === KYCStatus.RE_KYC_REQUIRED;
  const latestEvent = kyc.approvalHistory.at(-1);
  const gifsyRejected =
    isRejectedStatus && latestEvent?.stage === 'GIFSY' && latestEvent.action === 'REJECTED';
  // A first-approver rejection: rejected status AND the current cycle did NOT clear
  // the first approver as its latest outcome (the newest event is a first-approver
  // rejection, or there is no first-approver approval standing for this cycle).
  const firstApproverRejected = isRejectedStatus && !gifsyRejected;

  const step1: TimelineStep = {
    label: 'Submitted',
    sublabel: `${kyc.submittedByName} · ${new Date(kyc.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`,
    state: 'complete',
    testid: 'timeline-step-submitted',
  };

  // ── Step 2 — first approver (SO / ASM) ──────────────────────────────────────
  let step2State: StepState = 'pending';
  let step2Sub   = 'Pending review';
  if (firstApproverRejected) {
    step2State = 'rejected';
    step2Sub   = firstApproverEvent?.action === 'REJECTED' && firstApproverEvent.by
      ? `Rejected by ${firstApproverEvent.by}`
      : 'Rejected';
    // Prefer the current rejection remark (matches the page's rejection banner) over a
    // stale event note.
    const remark = kyc.rejectionReason ?? firstApproverEvent?.remarks;
    if (remark) step2Sub = `${step2Sub} — ${remark}`;
  } else if (gifsyRejected || kyc.status === KYCStatus.PENDING_GIFSY || kyc.status === KYCStatus.APPROVED) {
    // The current cycle cleared the first approver (it advanced to Gifsy / approved /
    // Gifsy-rejected), so the first-approver step is complete regardless of history gaps.
    step2State = 'complete';
    step2Sub   = firstApproverEvent?.action === 'APPROVED' && firstApproverEvent.by
      ? `Approved by ${firstApproverEvent.by}`
      : 'Approved';
  } else if (
    kyc.status === KYCStatus.PENDING_SO_APPROVAL ||
    kyc.status === KYCStatus.PENDING_ASM_APPROVAL
  ) {
    step2State = 'active';
    step2Sub   = 'Awaiting review';
  } else if (firstApproverEvent?.action === 'APPROVED') {
    // Defensive: an approved first-approver event with a non-standard status.
    step2State = 'complete';
    step2Sub   = firstApproverEvent.by ? `Approved by ${firstApproverEvent.by}` : 'Approved';
  }

  // ── Step 3 — Gifsy validation ───────────────────────────────────────────────
  // Keyed off kyc.status so a stale prior-cycle Gifsy event can never light this up
  // when the current cycle was bounced by the first approver.
  let step3State: StepState = 'pending';
  let step3Sub   = 'Pending first approval';
  if (firstApproverRejected) {
    // Current cycle never reached Gifsy — stays pending, never "Queued"/"Approved".
    step3State = 'pending';
    step3Sub   = 'Not yet reached';
  } else if (gifsyRejected) {
    step3State = 'rejected';
    const remark = kyc.rejectionReason ?? gifsyEvent?.remarks;
    step3Sub   = remark ? `Rejected — ${remark}` : 'Rejected';
  } else if (kyc.status === KYCStatus.APPROVED) {
    step3State = 'complete';
    step3Sub   = 'Approved';
  } else if (kyc.status === KYCStatus.PENDING_GIFSY) {
    step3State = 'active';
    step3Sub   = 'Under Gifsy review';
  } else if (step2State === 'complete') {
    // First approver cleared but not yet at Gifsy (transient) — queued.
    step3Sub = 'Queued for Gifsy';
  }

  return [
    step1,
    { label: stepFirstLabel, sublabel: step2Sub, state: step2State, testid: 'timeline-step-first-approver' },
    { label: 'Gifsy Validation',  sublabel: step3Sub, state: step3State, testid: 'timeline-step-gifsy' },
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
          <div key={step.label} data-testid={step.testid} className="flex gap-3">
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
  // Inline document preview (PDF → iframe, image → img) via a blob URL — mirrors the
  // Gifsy reviewer so a rep can preview any doc in-page, not only in a new tab.
  const [docPreview, setDocPreview] = useState<{ blobUrl: string; label: string; isPdf: boolean } | null>(null);
  const closeDocPreview = () =>
    setDocPreview((p) => { if (p) URL.revokeObjectURL(p.blobUrl); return null; });
  const previewDoc = (doc: KYCDoc) => {
    if (!doc.viewUrl) return;
    const b = dataUrlToBlob(doc.viewUrl);
    if (b && (b.mime === 'application/pdf' || b.mime.startsWith('image/'))) {
      setDocPreview({ blobUrl: b.url, label: doc.label, isPdf: b.mime === 'application/pdf' });
      return;
    }
    if (b) URL.revokeObjectURL(b.url); // non-previewable → fall back to a new tab
    openDocument(doc.viewUrl);
  };
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
          // Outlet-master mandated payout method (primary outlet), for reviewer verification.
          requiredPaymentType: s.partner?.outlets?.[0]?.requiredPaymentType ?? undefined,
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
          addressNameMismatch: s.addressNameMismatch === true,
          reKycFlags:      s.reKycFlags                        ?? undefined,
          gstNumber:       s.partner?.gstNumber,
          panNumber:       s.partner?.panNumber,
          bankName:        s.partner?.bankName,
          accountNumber:   s.partner?.bankAccountNumber,
          ifscCode:        s.partner?.ifscCode,
          upiId:           s.partner?.upiId,
          // Re-KYC (stage-at-approval): the live partner above still holds the OLD values;
          // diff the proposed patch so the reviewer sees WHAT they are approving (§ money path).
          // Address is diffed against the outlet (outlets[0]), not the partner scalars.
          proposedChanges: buildProposedChanges(s.partner, s.partner?.outlets?.[0], s.proposedPartner),
          documents:       (s.documents ?? []).map(mapDoc),
          // Store/owner photos are rendered as images; everything else lists as a doc row.
          photos:          (s.documents ?? [])
            .filter((d: { documentType: string; viewUrl?: string | null }) =>
              PHOTO_DOC_TYPES.has(d.documentType) && d.viewUrl)
            .map((d: { documentType: string; viewUrl?: string | null }) => ({
              label: docLabel(d.documentType),
              url:   d.viewUrl as string,
              documentType: d.documentType,
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

  // A re-KYC with staged identity/payout changes: auto-open the (default-closed) details
  // panel so the reviewer sees the proposed-vs-current values without hunting for them.
  useEffect(() => {
    if (kyc?.proposedChanges) setDetailsOpen(true);
  }, [kyc?.proposedChanges]);

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

  /* Re-entry: route the junior into the pre-filled new-KYC wizard (selects by outlet).
     Also fires on admin per-field re-KYC flags — a bulk-upload flag leaves the status
     APPROVED (so none of the status checks catch it), but the outlet still needs
     re-capture, so an APPROVED-but-flagged outlet must show "Edit & Resubmit".
     BUT once a fresh submission is under review (in-flight), the resubmit path is hidden —
     the flags persist for the approver highlight, so gate on isReKycActionable, not the raw
     flags. (The re-KYC banner below intentionally keeps showing during review.) */
  const isReEntry =
    kyc.status === KYCStatus.DRAFT ||
    kyc.status === KYCStatus.REJECTED ||
    kyc.status === KYCStatus.RE_UPLOAD_REQUIRED ||
    kyc.status === KYCStatus.RESUBMISSION_REQUIRED ||
    kyc.status === KYCStatus.RE_KYC_REQUIRED ||
    isReKycActionable(kyc.reKycFlags, kyc.status);

  /* Re-KYC document highlight (parity with the Gifsy reviewer): amber-badge the flagged
     documents + photos so the sales-senior approver sees exactly what was flagged for
     re-capture. Uses the RAW flags (hasReKycFlags) so the highlight stays visible while a
     resubmission is under review — mirroring the reviewer's flaggedDocTypes badge. */
  const flaggedDocSet = new Set(
    (hasReKycFlags(kyc.reKycFlags) ? flaggedDocTypes(kyc.reKycFlags) : []).map((t) => t.toLowerCase()),
  );
  const isDocFlagged = (documentType: string) => flaggedDocSet.has(documentType.toLowerCase());

  /* ── "Redeem for Outlet" gate ──────────────────────────────────────────────
     Owner decision: the redeem-on-behalf action lives on the OUTLET DETAIL view
     (this page, reached by tapping an outlet), surfaced prominently — NOT on the
     outlet list and NOT as a bottom-nav tab.

     Redeem is offered ONLY for an APPROVED outlet — a submitted-but-unapproved outlet
     has no access yet (the backend also gates redemption on KYC-APPROVED, so this just
     stops the button looking active before approval / during a pending re-KYC).
     showRedeem then hides redeem when the tenant restricts it to wholesalers
     (settings.salesApp.redeemGiftWholesalerOnly === true) AND this outlet is not a
     wholesaler. A normal redeemable outlet (wholesaler, OR any outlet when the
     restriction is off) shows the button. outletType now comes from the API (the
     detail endpoint selects outletType.code) so the gate no longer collapses to
     "always hidden" from an undefined type. */
  const showRedeem =
    isApproved &&
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
            {kyc.addressNameMismatch && (
              <span
                data-testid="address-name-mismatch-badge"
                className="flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded-full"
              >
                <AlertTriangle className="h-2.5 w-2.5" />
                Names differ — shop board vs address proof
              </span>
            )}
          </div>
        </div>
        {statusCfg && <Badge variant={statusCfg.variant} className="shrink-0">{statusCfg.label}</Badge>}
      </div>

      {/* Rejection banner */}
      {kyc.rejectionReason && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-start gap-2">
          <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{kyc.rejectionReason}</p>
        </div>
      )}

      {/* Re-KYC requested — the admin flagged specific fields for re-capture (bulk upload
          or reviewer). Distinct amber banner (vs the red rejection above); serves both the
          rep who must resubmit and the sales-senior approver reviewing this outlet. */}
      {hasReKycFlags(kyc.reKycFlags) && (
        <div
          data-testid="rekyc-banner"
          className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2"
        >
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-800">Re-KYC requested</p>
            <p className="text-xs text-amber-700 mt-0.5">
              The following {flaggedLabels(kyc.reKycFlags).length === 1 ? 'field needs' : 'fields need'} re-capture:{' '}
              <span className="font-medium">{flaggedLabels(kyc.reKycFlags).join(', ')}</span>
            </p>
            {reKycRemarks(kyc.reKycFlags) && (
              <p className="text-xs text-amber-700 mt-1 italic">{reKycRemarks(kyc.reKycFlags)}</p>
            )}
          </div>
        </div>
      )}

      {/* Re-KYC staged changes: the live partner fields still hold the OLD values; the NEW
          (proposed) values are what approval applies. Surface up-front + auto-open details so
          the reviewer never approves stale identity/payout data. */}
      {kyc.proposedChanges && (
        <div
          data-testid="proposed-changes-banner"
          className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-start gap-2"
        >
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-800">Proposed identity / payout changes</p>
            <p className="text-xs text-amber-700 mt-0.5">
              This re-KYC proposes new values (shown in Store Information with the old value as
              &ldquo;was …&rdquo;). Changed:{' '}
              <span className="font-medium">
                {(Object.keys(kyc.proposedChanges) as ProposedFieldKey[])
                  .map((k) => PROPOSED_FIELD_LABELS[k]).join(', ')}
              </span>
            </p>
          </div>
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
                  { icon: <User className="h-3.5 w-3.5" />,   label: 'Owner Name', value: <ProposedFieldValue change={kyc.proposedChanges?.ownerName}>{kyc.ownerName}</ProposedFieldValue> },
                  { icon: <Phone className="h-3.5 w-3.5" />,  label: 'Mobile',  value: <ProposedFieldValue change={kyc.proposedChanges?.phone}>{`+91 ${kyc.outletPhone}`}</ProposedFieldValue> },
                  { icon: <MapPin className="h-3.5 w-3.5" />, label: 'Address', value: <ProposedFieldValue change={kyc.proposedChanges?.address}>{[kyc.address, kyc.city, kyc.state, kyc.pincode].filter(Boolean).join(', ') || '—'}</ProposedFieldValue> },
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
                {(kyc.gstNumber || kyc.proposedChanges?.gstNumber) && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">GST</span>
                    <span data-testid="kyc-store-gst" className="text-sm font-mono text-gray-800">
                      <ProposedFieldValue change={kyc.proposedChanges?.gstNumber}>{kyc.gstNumber}</ProposedFieldValue>
                    </span>
                  </div>
                )}
                {(kyc.panNumber || kyc.proposedChanges?.panNumber) && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">PAN</span>
                    <span data-testid="kyc-store-pan" className="text-sm font-mono text-gray-800">
                      <ProposedFieldValue change={kyc.proposedChanges?.panNumber}>{kyc.panNumber}</ProposedFieldValue>
                    </span>
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
                    {kyc.photos.map((photo, i) => {
                      const flagged = isDocFlagged(photo.documentType);
                      return (
                      <button
                        key={photo.url}
                        data-testid={flagged ? 'rekyc-flagged-photo-thumb' : 'outlet-photo-thumb'}
                        onClick={() => setPhotoLightboxIndex(i)}
                        className={`relative aspect-video rounded-lg overflow-hidden bg-gray-50 group ${
                          flagged ? 'border-2 border-amber-300' : 'border border-gray-200'
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={photo.url} alt={photo.label} className="w-full h-full object-cover group-hover:opacity-90 transition-opacity" />
                        {flagged && (
                          <span className="absolute top-1 right-1 text-[9px] font-semibold text-amber-800 bg-amber-100 border border-amber-200 rounded px-1 py-0.5">
                            Re-capture
                          </span>
                        )}
                        <span className="absolute bottom-0 inset-x-0 bg-black/55 text-white text-[10px] font-medium px-1.5 py-0.5 text-left truncate">{photo.label}</span>
                      </button>
                      );
                    })}
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
                  return docRows.map(doc => {
                    const flagged = isDocFlagged(doc.documentType);
                    return (
                    <div
                      key={doc.id}
                      data-testid={flagged ? 'rekyc-flagged-doc-row' : undefined}
                      className={`flex items-center justify-between gap-2 ${
                        flagged ? 'rounded-md border border-amber-200 bg-amber-50 px-2 py-1' : 'py-0.5'
                      }`}
                    >
                      <span className={`text-sm truncate ${flagged ? 'text-amber-800 font-medium' : 'text-gray-700'}`}>{doc.label}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        {flagged && (
                          <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 rounded px-1.5 py-0.5 whitespace-nowrap">
                            Needs re-capture
                          </span>
                        )}
                        {doc.viewUrl ? (
                          <button
                            type="button"
                            onClick={() => previewDoc(doc)}
                            data-testid="kyc-doc-view-link"
                            className="text-xs text-blue-600 hover:underline"
                          >
                            View
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400">Not uploaded</span>
                        )}
                      </div>
                    </div>
                    );
                  });
                })()}
              </div>
            </div>

            {/* Inline document preview (PDF → iframe, image → img; both via a blob URL). */}
            {docPreview && (
              <div
                data-testid="kyc-doc-preview"
                className="fixed inset-0 z-50 bg-black/80 flex flex-col items-center justify-center p-4"
                onClick={closeDocPreview}
              >
                <div
                  className="bg-white rounded-lg w-full max-w-3xl max-h-[88vh] overflow-hidden flex flex-col"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
                    <span className="text-sm font-medium text-gray-800 truncate">{docPreview.label}</span>
                    <div className="flex items-center gap-3 shrink-0">
                      <a href={docPreview.blobUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">Open in new tab</a>
                      <button type="button" className="text-xs text-gray-500 underline" onClick={closeDocPreview}>Close</button>
                    </div>
                  </div>
                  {docPreview.isPdf ? (
                    <iframe src={docPreview.blobUrl} title={docPreview.label} className="w-full h-[78vh] bg-white" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={docPreview.blobUrl} alt={docPreview.label} className="w-full max-h-[78vh] object-contain bg-gray-50" />
                  )}
                </div>
              </div>
            )}

            {/* Payment Details — the KYC form captures bank OR UPI; show whichever was given.
                Also shows when a re-KYC stages a payment change even if the live value is empty. */}
            {(() => {
              const c = kyc.proposedChanges;
              const paymentRows = [
                { label: 'Bank',           value: kyc.bankName as ReactNode, change: c?.bankName          },
                { label: 'Account',        value: kyc.accountNumber as ReactNode, change: c?.bankAccountNumber },
                { label: 'Account Holder', value: undefined as ReactNode, change: c?.bankAccountHolder  },
                { label: 'IFSC',           value: kyc.ifscCode as ReactNode, change: c?.ifscCode          },
                { label: 'UPI ID',         value: kyc.upiId as ReactNode, change: c?.upiId             },
                { label: 'Payment Mode',   value: undefined as ReactNode, change: c?.paymentMode       },
              ].filter(row => row.value || row.change);
              if (paymentRows.length === 0) return null;
              return (
                <>
                  <div className="border-t border-gray-100" />
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Payment Details</p>
                      {kyc.requiredPaymentType && REQUIRED_PAYMENT_LABELS[kyc.requiredPaymentType] && (
                        <span
                          data-testid="required-payout-pill"
                          className="text-[10px] font-semibold text-gray-500 bg-gray-100 border border-gray-200 px-1.5 py-0.5 rounded-full"
                        >
                          Required payout: {REQUIRED_PAYMENT_LABELS[kyc.requiredPaymentType]}
                        </span>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {paymentRows.map(row => (
                        <div key={row.label} className="flex items-center justify-between">
                          <span className="text-xs text-gray-400">{row.label}</span>
                          <span className="text-sm font-medium text-gray-800 font-mono">
                            <ProposedFieldValue change={row.change}>{row.value}</ProposedFieldValue>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              );
            })()}
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
