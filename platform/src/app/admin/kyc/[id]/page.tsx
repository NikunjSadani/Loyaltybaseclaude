'use client';

import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { use } from 'react';
import {
  ArrowLeft,
  Building2,
  Phone,
  MapPin,
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
  AlertTriangle,
  CreditCard,
  FileText,
} from 'lucide-react';
import Link from 'next/link';
import { Spinner } from '@/components/ui/spinner';
import { KYCReviewer } from '@/components/admin/kyc-reviewer';
import {
  hasReKycFlags, reKycRemarks, flaggedLabels, flaggedDocTypes, type ReKycFlags,
} from '@/lib/rekyc-fields';
import type { EntityType, GSTRegistrationType } from '@/lib/invoice';

// ─── 7-field verification types (shared with approvals page) ─────────────────

type KycFieldKey =
  | 'PAYMENT'
  | 'GST_VALIDATION'
  | 'GST_DOCUMENT'
  | 'ADDRESS'
  | 'ADDRESS_DOCUMENT'
  | 'BOARD_PHOTO'
  | 'OWNER_PHOTO';

type KycFieldDecision = 'PENDING' | 'APPROVED' | 'REJECTED';

interface KycFieldState {
  decision: KycFieldDecision;
  remark?: string;
  // 'GROUP_INHERITED' = the field was auto-verified from the outlet's approved owner group
  // (grouped child: PAYMENT / GST_VALIDATION / GST_DOCUMENT carry the group's decision).
  source?: 'EXCEL' | 'PORTAL' | 'GROUP_INHERITED';
}

const KYC_FIELD_ORDER: KycFieldKey[] = [
  'PAYMENT', 'GST_VALIDATION', 'GST_DOCUMENT',
  'ADDRESS', 'ADDRESS_DOCUMENT', 'BOARD_PHOTO', 'OWNER_PHOTO',
];

const KYC_FIELD_LABELS: Record<KycFieldKey, string> = {
  PAYMENT: 'Payment (Bank/UPI)',
  GST_VALIDATION: 'GST Validation',
  GST_DOCUMENT: 'GST Document',
  ADDRESS: 'Address',
  ADDRESS_DOCUMENT: 'Address Document',
  BOARD_PHOTO: 'Store Board Photo',
  OWNER_PHOTO: 'Owner Photo',
};

/** Unwrap the backend { success, data } envelope. Throws on success=false. */
async function unwrapJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` })) as
    | { success: true; data: T }
    | { success: false; error?: string };
  if (!res.ok || !body.success) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return (body as { success: true; data: T }).data;
}

const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  INDIVIDUAL: 'Individual / Proprietor',
  HUF: 'Hindu Undivided Family (HUF)',
  COMPANY: 'Private / Public Limited Company',
  FIRM: 'Partnership Firm',
  LLP: 'Limited Liability Partnership (LLP)',
  OTHERS: 'Others',
};

const GST_REG_LABELS: Record<GSTRegistrationType, string> = {
  REGULAR: 'Regular',
  UNREGISTERED: 'Unregistered',
  COMPOSITE: 'Composition Scheme',
};

/* ─── API types ──────────────────────────────────────────────────────────────── */

interface ApiKycDetail {
  id: string;
  status: string;
  submittedAt?: string | null;
  createdAt?: string;
  // Decision timestamps — the SLA clock stops at the decision, not "now" (see kycStageSla).
  reviewedAt?: string | null;
  approvedAt?: string | null;
  updatedAt?: string | null;
  rejectionReason?: string | null;
  reviewerNotes?: string | null;
  // Rep-declared mismatch between the shop board name and the address-proof name
  // (address proof skipped for waiver-enabled tenants).
  addressNameMismatch?: boolean;
  reKycFlags?: ReKycFlags;
  // Wave-3 grouped child: per-field "current value matches the approved parent" map,
  // server-computed PRE-MASK (safe under PII masking). Keyed on panNumber/gstNumber/
  // bankAccountNumber/ifscCode/upiId/bankName/bankAccountHolder/ownerName/businessName/phone.
  parentVerified?: Record<string, boolean>;
  // Wave-4 "group-leave via re-KYC" (Option A): server-computed — true iff this re-KYC's
  // proposed PAN differs from the group PAN, so approving DETACHES the outlet from its owner
  // group (re-establishes it as an independent shop). Default false / absent = normal.
  willLeaveGroup?: boolean;
  // Gifsy-set classification (current stored values; null until an admin saves them).
  entityType?: EntityType | null;
  gstRegistrationType?: GSTRegistrationType | null;
  // Non-null when the outlet's owner-group already has an APPROVED classification — the
  // fields are LOCKED to these values (one entity/registration type per organisation).
  classificationLock?: { entityType: EntityType; gstRegistrationType: GSTRegistrationType; sourcePartnerId: string } | null;
  // KYC-captured geo (Prisma Decimal → JSON string on the wire).
  boardPhotoLat?: string | number | null; boardPhotoLng?: string | number | null;
  paymentLat?: string | number | null; paymentLng?: string | number | null;
  user: { id: string; name: string; phone: string; role?: string };
  partner?: {
    id: string; businessName: string; ownerName?: string | null; partnerCode?: string | null;
    phone?: string;
    gstNumber?: string | null; panNumber?: string | null;
    address?: string | null; city?: string | null; state?: string | null; pincode?: string | null;
    bankName?: string | null; bankAccountNumber?: string | null; bankAccountHolder?: string | null;
    ifscCode?: string | null; upiId?: string | null; paymentMode?: string | null;
    outlets?: { name?: string; outletCode: string; phone?: string;
      requiredPaymentType?: 'BANK' | 'UPI' | 'ANY' | null;
      addressLine1?: string | null; addressLine2?: string | null;
      city?: string | null; state?: string | null; pincode?: string | null }[];
  } | null;
  // Re-KYC (stage-at-approval): the PROPOSED (new) identity/payout values staged on the
  // submission and applied to the live partner only at Gifsy approval. Present ONLY for a
  // re-KYC that staged changes (else null/absent). Same field names + masking as `partner`.
  proposedPartner?: {
    businessName?: string | null; ownerName?: string | null; phone?: string | null;
    gstNumber?: string | null; panNumber?: string | null;
    bankName?: string | null; bankAccountNumber?: string | null; bankAccountHolder?: string | null;
    ifscCode?: string | null; upiId?: string | null; paymentMode?: string | null;
    // Outlet address is staged the same way and applied to the live outlet only at approval.
    addressLine1?: string | null; addressLine2?: string | null;
    city?: string | null; state?: string | null; pincode?: string | null;
  } | null;
  documents?: { id: string; documentType: string; fileUrl?: string; viewUrl?: string | null; status: string }[];
  verificationItems?: { fieldKey: string; decision: string; remark?: string | null; source?: string | null }[];
  statusHistory?: { id: string; toStatus: string; createdAt: string; notes?: string | null }[];
}

type KycDetailShape = {
  id: string; outletCode: string; outletName: string; firmName: string; ownerName: string; mobile: string; email: string;
  partnerClass: string; gstNumber: string; panNumber: string;
  address: string; city: string; state: string; pincode: string;
  boardGeo: { lat: number; lng: number } | null;
  paymentGeo: { lat: number; lng: number } | null;
  salesUser: string; territory: string; region: string;
  submittedDate: string; status: string;
  bankName: string; accountNumber: string; ifscCode: string; upiId: string;
  // Outlet-master mandated payout method (primary outlet); '' when unset.
  requiredPaymentType: '' | 'BANK' | 'UPI' | 'ANY';
  pennyDropStatus: 'verified' | 'failed' | 'pending';
  agreementStatus: 'signed' | 'pending'; agreementDate: string;
  statusHistory: Array<{ status: string; timestamp: string; user: string; remark?: string }>;
  auditLog: Array<{ action: string; user: string; timestamp: string; detail: string }>;
  documents: Array<{ id: string; type: string; label: string; url: string; status: 'pending' | 'verified' | 'rejected' }>;
  verificationItems: Array<{ fieldKey: string; decision: string; remark?: string | null; source?: string | null }>;
  reKycFlags: ReKycFlags;
  addressNameMismatch: boolean;
  // Re-KYC staged identity/payout changes (proposed vs current), or undefined when none.
  proposedChanges?: ProposedChanges;
  // Wave-3: per-field "matches the approved parent" flags (grouped child), or undefined.
  parentVerified?: Record<string, boolean>;
  // Wave-4: true iff approving this re-KYC detaches the outlet from its owner group
  // (proposed PAN differs from the group PAN). Drives the group-leave warning banner.
  willLeaveGroup: boolean;
  // Gifsy classification (current stored values; null until saved). Seeds the two selects.
  entityType: EntityType | null;
  gstRegistrationType: GSTRegistrationType | null;
  // Non-null when the owner-group already has an APPROVED classification → selects locked.
  classificationLock: { entityType: EntityType; gstRegistrationType: GSTRegistrationType; sourcePartnerId: string } | null;
};

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
  gstNumber: 'GSTIN', panNumber: 'PAN', bankName: 'Bank',
  bankAccountNumber: 'Account No.', bankAccountHolder: 'Account Holder',
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

/**
 * Diff the PROPOSED (re-KYC-staged) identity/payout values against the still-live
 * partner values. Only a field whose proposed value is a non-empty string AND differs
 * from the current value is returned (an absent/empty proposed key = "untouched", matching
 * the backend apply semantics). Both sides are already role-masked by the backend, so a
 * masked caller only sees a diff when the unmasked-last-4 differs — acceptable; the Gifsy
 * admin (unmasked) sees the full diff. Returns undefined when nothing changed / no re-KYC.
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
  change, children, mono = false,
}: { change?: ProposedFieldChange; children: ReactNode; mono?: boolean }): ReactNode {
  if (!change) return children;
  return (
    <span className="flex flex-col gap-0.5" data-testid="proposed-change">
      <span className="flex items-center gap-1.5 flex-wrap">
        <span className={`text-gray-900 font-semibold ${mono ? 'font-mono' : ''}`}>
          {change.proposed || '—'}
        </span>
        <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full whitespace-nowrap">
          Proposed change
        </span>
      </span>
      <span className="text-[10px] text-gray-400">
        was: <span className={mono ? 'font-mono' : ''}>{change.current || '—'}</span>
      </span>
    </span>
  );
}

/**
 * Wave-3 grouped child: a subtle emerald badge shown next to an identity field whose CURRENT
 * value matches the outlet's APPROVED parent. Deliberately distinct from the amber "Proposed
 * change" pill — a field can be BOTH (it renders both, side by side). Keys off the child's
 * current value via `parentVerified[field]` (server-computed pre-mask), so a masked reviewer
 * still sees it. Renders nothing when not verified (purely additive).
 */
function VerifiedOnParentBadge({ verified }: { verified?: boolean }): ReactNode {
  if (!verified) return null;
  return (
    <span
      data-testid="verified-on-parent-badge"
      className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-sans font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full whitespace-nowrap align-middle"
    >
      <CheckCircle className="w-2.5 h-2.5" /> Verified on parent
    </span>
  );
}

/**
 * Grouped child: a small badge shown on a verification field whose decision was
 * AUTO-VERIFIED from the outlet's approved owner group (source === 'GROUP_INHERITED').
 * On a grouped child the PAYMENT / GST_VALIDATION / GST_DOCUMENT items inherit the group's
 * decision (the reviewer still handles address/photo items). Styled to mirror the emerald
 * VerifiedOnParentBadge. Renders nothing when the field wasn't group-inherited.
 */
function GroupInheritedBadge({ inherited }: { inherited?: boolean }): ReactNode {
  if (!inherited) return null;
  return (
    <span
      data-testid="group-inherited-badge"
      className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-sans font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full whitespace-nowrap align-middle"
    >
      <CheckCircle className="w-2.5 h-2.5" /> Auto-verified from group
    </span>
  );
}

/** Coerce a KYC-captured lat/lng pair (Prisma Decimal → JSON string) into numbers.
 *  Returns null unless BOTH are present and finite. */
function parseGeo(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln)) return null;
  return { lat: la, lng: ln };
}

function mapApiKycDetail(s: ApiKycDetail): KycDetailShape {
  const submittedAt = s.submittedAt ?? s.createdAt ?? '';
  const docStatusMap: Record<string, 'pending' | 'verified' | 'rejected'> = {
    SUBMITTED: 'pending', APPROVED: 'verified', REJECTED: 'rejected',
  };
  // Re-KYC staged changes: scalar identity/payout diff + the outlet-address diff (current
  // address lives on outlets[0], not the partner scalars → diffed separately).
  const proposedRaw = s.proposedPartner as Record<string, unknown> | null | undefined;
  const scalarChanges = computeProposedChanges(s.partner as Record<string, unknown> | null | undefined, proposedRaw);
  const addressChange = computeAddressChange(
    s.partner?.outlets?.[0] as Record<string, unknown> | null | undefined,
    proposedRaw,
  );
  const proposedChanges: ProposedChanges | undefined =
    scalarChanges || addressChange
      ? { ...(scalarChanges ?? {}), ...(addressChange ? { address: addressChange } : {}) }
      : undefined;
  return {
    id:               s.id,
    reKycFlags:       s.reKycFlags ?? null,
    addressNameMismatch: s.addressNameMismatch === true,
    proposedChanges,
    parentVerified:   s.parentVerified ?? undefined,
    willLeaveGroup:   s.willLeaveGroup === true,
    entityType:       s.entityType ?? null,
    gstRegistrationType: s.gstRegistrationType ?? null,
    classificationLock: s.classificationLock ?? null,
    verificationItems: s.verificationItems ?? [],
    // Human outlet ID for the header (KYC is partner-keyed → the enrolled outlet's code).
    // Prefer the real Outlet code; fall back to the partner code if no outlet is linked yet.
    outletCode:       s.partner?.outlets?.[0]?.outletCode ?? s.partner?.partnerCode ?? '',
    outletName:       s.partner?.outlets?.[0]?.name ?? s.partner?.businessName ?? '',
    firmName:         s.partner?.outlets?.[0]?.name ?? s.partner?.businessName ?? '',
    // OWNER/contact-person name — the reviewer checks this against the PAN/Aadhaar docs.
    ownerName:        s.partner?.ownerName ?? '',
    mobile:           s.partner?.outlets?.[0]?.phone ?? s.partner?.phone ?? '',
    email:            '',
    partnerClass:     '',
    gstNumber:        s.partner?.gstNumber ?? '',
    panNumber:        s.partner?.panNumber ?? '',
    // Address lives on the OUTLET (captured at KYC), not ChannelPartner.
    address:          [s.partner?.outlets?.[0]?.addressLine1, s.partner?.outlets?.[0]?.addressLine2].filter(Boolean).join(', ') || (s.partner?.address ?? ''),
    city:             s.partner?.outlets?.[0]?.city ?? s.partner?.city ?? '',
    state:            s.partner?.outlets?.[0]?.state ?? s.partner?.state ?? '',
    pincode:          s.partner?.outlets?.[0]?.pincode ?? s.partner?.pincode ?? '',
    // Geo captured during KYC (on the submission, not the outlet).
    boardGeo:         parseGeo(s.boardPhotoLat, s.boardPhotoLng),
    paymentGeo:       parseGeo(s.paymentLat, s.paymentLng),
    salesUser:        '',
    territory:        '',
    region:           '',
    submittedDate:    submittedAt.slice(0, 10),
    status:           s.status,
    bankName:         s.partner?.bankName ?? '',
    accountNumber:    s.partner?.bankAccountNumber ?? '',
    ifscCode:         s.partner?.ifscCode ?? '',
    upiId:            s.partner?.upiId ?? '',
    requiredPaymentType: s.partner?.outlets?.[0]?.requiredPaymentType ?? '',
    pennyDropStatus:  'pending',
    agreementStatus:  'pending',
    agreementDate:    '',
    statusHistory:    (s.statusHistory ?? []).map(h => ({
      status:    h.toStatus,
      timestamp: new Date(h.createdAt).toLocaleString('en-IN'),
      user:      'System',
      remark:    h.notes ?? undefined,
    })),
    auditLog:  [],
    documents: (s.documents ?? []).map(d => ({
      id:     d.id,
      type:   d.documentType.toLowerCase(),
      label:  d.documentType.replace(/_/g, ' '),
      // viewUrl is the signed (or fail-closed null) read URL; never fall back to the
      // raw private GCS fileUrl (renders a 403/broken image) — use the placeholder.
      url:    d.viewUrl ?? `https://placehold.co/600x400/e2e8f0/1a1a2e?text=${d.documentType}`,
      status: docStatusMap[d.status] ?? 'pending',
    })),
  };
}

/** Friendly label for the outlet-mandated payout method (from the outlet master). */
const REQUIRED_PAYMENT_LABELS: Record<string, string> = {
  BANK: 'Bank account',
  UPI: 'UPI',
  ANY: "Any (rep's choice)",
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

// ─── Per-field verification panel (wired to POST /api/kyc/:id/verify) ─────────

function KycFieldVerificationPanel({
  submissionId,
  initialItems,
}: {
  submissionId: string;
  initialItems?: { fieldKey: string; decision: string; remark?: string | null; source?: string | null }[];
}) {
  const [fields, setFields] = useState<Record<KycFieldKey, KycFieldState>>(() => {
    const out = {} as Record<KycFieldKey, KycFieldState>;
    for (const k of KYC_FIELD_ORDER) out[k] = { decision: 'PENDING' };
    // Seed from the submission's existing verification items (3.4d).
    for (const it of initialItems ?? []) {
      if ((KYC_FIELD_ORDER as string[]).includes(it.fieldKey)) {
        out[it.fieldKey as KycFieldKey] = {
          decision: it.decision as KycFieldDecision,
          remark: it.remark ?? undefined,
          source: (it.source as KycFieldState['source']) ?? undefined,
        };
      }
    }
    return out;
  });
  const [remarkInputs, setRemarkInputs] = useState<Record<KycFieldKey, string>>(
    () => Object.fromEntries(KYC_FIELD_ORDER.map(k => [k, ''])) as Record<KycFieldKey, string>
  );
  const [fieldLoading, setFieldLoading] = useState<Record<KycFieldKey, boolean>>(
    () => Object.fromEntries(KYC_FIELD_ORDER.map(k => [k, false])) as Record<KycFieldKey, boolean>
  );
  const [fieldError, setFieldError] = useState<Record<KycFieldKey, string>>(
    () => Object.fromEntries(KYC_FIELD_ORDER.map(k => [k, ''])) as Record<KycFieldKey, string>
  );
  const [derivedStatus, setDerivedStatus] = useState<string | null>(null);
  // Set when the backend PERSISTS the last field decision but holds the submission at
  // PENDING_GIFSY because the Gifsy classification is still unset (classificationRequired).
  // This is NOT a field error — it points the reviewer up to the Classification section.
  const [classificationRequired, setClassificationRequired] = useState(false);

  const applyField = useCallback(
    async (key: KycFieldKey, decision: 'APPROVED' | 'REJECTED', remark?: string) => {
      setFieldLoading(prev => ({ ...prev, [key]: true }));
      setFieldError(prev => ({ ...prev, [key]: '' }));
      try {
        const res = await fetch(`/api/kyc/${submissionId}/verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ fieldKey: key, decision, remark: remark ?? undefined }),
        });
        const data = await unwrapJson<{
          fieldKey: KycFieldKey;
          fieldDecision: 'APPROVED' | 'REJECTED';
          derivedStatus: string;
          // true = all fields verified but classification unset; decision IS persisted.
          classificationRequired?: boolean;
        }>(res);
        setFields(prev => ({
          ...prev,
          [key]: { decision: data.fieldDecision, remark, source: 'PORTAL' as const },
        }));
        setDerivedStatus(data.derivedStatus);
        // The decision was persisted (chip shows APPROVED); the submission is held pending
        // classification. Surface the pointer notice instead of a per-field error.
        setClassificationRequired(data.classificationRequired === true);
        // Clear the remark input after a successful reject
        if (decision === 'REJECTED') {
          setRemarkInputs(prev => ({ ...prev, [key]: '' }));
        }
      } catch (err) {
        setFieldError(prev => ({
          ...prev,
          [key]: err instanceof Error ? err.message : 'Field verify failed.',
        }));
      } finally {
        setFieldLoading(prev => ({ ...prev, [key]: false }));
      }
    },
    [submissionId]
  );

  const terminalCount = KYC_FIELD_ORDER.filter(k => fields[k].decision !== 'PENDING').length;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-800">
          Field Verification (Gifsy Admin)
        </h2>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          terminalCount === 7 ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
        }`}>
          {terminalCount}/7 done
        </span>
      </div>

      {derivedStatus && derivedStatus !== 'PENDING_GIFSY' && (
        <div className={`mb-3 text-xs px-3 py-2 rounded flex items-center gap-2 ${
          derivedStatus === 'APPROVED'
            ? 'bg-green-50 border border-green-200 text-green-800'
            : 'bg-amber-50 border border-amber-200 text-amber-800'
        }`}>
          {derivedStatus === 'APPROVED'
            ? <CheckCircle className="w-3.5 h-3.5 shrink-0" />
            : <RefreshCw className="w-3.5 h-3.5 shrink-0" />}
          Derived status: <strong>{derivedStatus}</strong>
        </div>
      )}

      {classificationRequired && (
        <div
          data-testid="classification-required-notice"
          className="mb-3 text-xs px-3 py-2 rounded flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          All fields verified — set &amp; save Entity Type and GST Registration Type above to finalize approval.
        </div>
      )}

      <p className="text-[10px] text-gray-400 mb-3">
        These decisions call <code>POST /api/kyc/{submissionId}/verify</code> directly.
        The backend runs the bridge after each field — if all 7 are terminal it auto-transitions
        the submission (APPROVED or RE_UPLOAD_REQUIRED).
      </p>

      <div className="divide-y divide-gray-100">
        {KYC_FIELD_ORDER.map(key => {
          const state = fields[key];
          const remark = remarkInputs[key];
          const canReject = remark.trim().length > 0;
          const isLoading = fieldLoading[key];
          const err = fieldError[key];

          return (
            <div key={key} className="py-3 flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
              {/* Label + chip */}
              <div className="sm:w-44 shrink-0">
                <p className="text-xs font-medium text-gray-700">
                  {KYC_FIELD_LABELS[key]}
                  <GroupInheritedBadge inherited={state.source === 'GROUP_INHERITED'} />
                </p>
                <div className="mt-1">
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                    state.decision === 'APPROVED' ? 'bg-green-100 text-green-800' :
                    state.decision === 'REJECTED' ? 'bg-red-100 text-red-700' :
                    'bg-gray-100 text-gray-500'
                  }`}>
                    {state.decision === 'APPROVED' && <CheckCircle className="h-3 w-3" />}
                    {state.decision === 'REJECTED' && <XCircle className="h-3 w-3" />}
                    {state.decision}
                    {state.source && <span className="text-[10px] font-normal opacity-70">[{state.source}]</span>}
                  </span>
                </div>
                {state.decision === 'REJECTED' && state.remark && (
                  <p className="text-xs text-red-600 mt-0.5 italic">{state.remark}</p>
                )}
              </div>

              {/* Controls */}
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    disabled={isLoading}
                    onClick={() => applyField(key, 'APPROVED')}
                    className="flex items-center gap-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs h-6 px-2.5 rounded font-medium"
                  >
                    {isLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                    Approve
                  </button>

                  <input
                    type="text"
                    placeholder="Remark (required)"
                    value={remark}
                    disabled={isLoading}
                    onChange={e => setRemarkInputs(prev => ({ ...prev, [key]: e.target.value }))}
                    className="border border-gray-200 rounded px-2 py-0.5 text-xs h-6 w-44 focus:outline-none focus:ring-1 focus:ring-red-300 disabled:opacity-50"
                  />

                  <button
                    disabled={!canReject || isLoading}
                    onClick={() => applyField(key, 'REJECTED', remark.trim())}
                    title={canReject ? undefined : 'Enter a remark to reject'}
                    className="flex items-center gap-1 bg-red-600 hover:bg-red-700 disabled:opacity-40 text-white text-xs h-6 px-2.5 rounded font-medium"
                  >
                    <XCircle className="h-3 w-3" />Reject
                  </button>
                </div>
                {err && (
                  <span className="text-xs text-red-600 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />{err}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main detail page ─────────────────────────────────────────────────────────

export default function KYCDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [kyc, setKyc] = useState<KycDetailShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [actionError, setActionError]   = useState<string | null>(null);

  // Gifsy-admin-only classification, set during KYC review. No pre-selected default — the
  // empty placeholder is shown until the reviewer picks (or the stored value seeds it).
  const [entityType, setEntityType] = useState<EntityType | ''>('');
  const [gstRegType, setGstRegType] = useState<GSTRegistrationType | ''>('');
  const [savingClassification, setSavingClassification] = useState(false);
  const [classificationError, setClassificationError] = useState<string | null>(null);

  const loadKyc = useCallback(async () => {
    const res = await fetch(`/api/kyc/${id}`);
    const json = (await res.json().catch(() => ({ success: false }))) as {
      success: boolean; data?: { submission: ApiKycDetail }; error?: string;
    };
    if (json.success && json.data) {
      setKyc(mapApiKycDetail(json.data.submission));
      setError(null);
    } else {
      setError(json.error ?? 'KYC submission not found');
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    loadKyc()
      .catch(() => setError('Failed to load KYC submission'))
      .finally(() => setLoading(false));
  }, [id, loadKyc]);

  // Seed the classification selects from the loaded submission (re-runs on every reload,
  // e.g. after a save). A locked group classification wins; otherwise the stored values,
  // falling back to the empty placeholder when nothing is set yet. The saved/dirty state is
  // derived (current selection vs persisted values) — no separate one-way flag to drift.
  useEffect(() => {
    if (!kyc) return;
    setEntityType(kyc.classificationLock?.entityType ?? kyc.entityType ?? '');
    setGstRegType(kyc.classificationLock?.gstRegistrationType ?? kyc.gstRegistrationType ?? '');
    setClassificationError(null);
  }, [kyc]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !kyc) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-500 text-sm">{error ?? 'KYC submission not found'}</p>
        <Link href="/admin/kyc" className="text-[var(--brand-primary)] text-sm mt-2 inline-block">← Back to KYC List</Link>
      </div>
    );
  }

  // Real decision actions — these used to be local-only stubs that just flashed a
  // success banner without ever calling the backend (so a Gifsy admin's "Reject KYC"
  // did nothing). They now POST to the API and refresh the submission so the status
  // badge + document panel reflect the new state.
  const postAction = async (
    path: string,
    body: Record<string, unknown> | undefined,
    onOkMessage: string,
  ) => {
    setActionError(null);
    setActionResult(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = (await res.json().catch(() => ({ success: false }))) as {
        success: boolean; error?: string; message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? json.message ?? `Request failed (${res.status})`);
      }
      await loadKyc();
      setActionResult(onOkMessage);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed.');
    }
  };

  const handleApprove = (kycId: string) =>
    postAction(`/api/kyc/${kycId}/approve`, undefined, 'KYC approved successfully. Partner notified.');
  const handleReject = (kycId: string, reason: string) =>
    postAction(`/api/kyc/${kycId}/reject`, { reason, status: 'REJECTED' }, `KYC rejected. Reason: ${reason}`);
  const handleReupload = (kycId: string, reason: string) =>
    postAction(
      `/api/kyc/${kycId}/reject`,
      { reason, status: 'RE_UPLOAD_REQUIRED' },
      `Re-upload requested. Partner notified. Reason: ${reason}`,
    );

  const classificationLock = kyc.classificationLock;
  // Persist the Gifsy classification. Both enums are required; the backend 400s if a value
  // diverges from a locked group classification (surfaced inline). On success the submission
  // is re-fetched so the selects reflect what is actually stored.
  const handleSaveClassification = async () => {
    if (!entityType || !gstRegType || savingClassification) return;
    setSavingClassification(true);
    setClassificationError(null);
    try {
      const res = await fetch(`/api/kyc/${id}/gst-details`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType, gstRegistrationType: gstRegType }),
      });
      const json = (await res.json().catch(() => ({ success: false }))) as {
        success: boolean; error?: string; message?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? json.message ?? `Request failed (${res.status})`);
      }
      await loadKyc();
    } catch (err) {
      setClassificationError(err instanceof Error ? err.message : 'Could not save classification.');
    } finally {
      setSavingClassification(false);
    }
  };

  // Approve is compulsory-gated on a SET + PERSISTED classification. A locked group
  // classification counts as persisted (authoritative from the group). Otherwise the stored
  // values must both exist AND equal the currently-selected values (no unsaved edits).
  const classificationComplete = Boolean(entityType && gstRegType);
  const classificationPersisted = Boolean(classificationLock) || (
    kyc.entityType != null && kyc.gstRegistrationType != null &&
    kyc.entityType === entityType && kyc.gstRegistrationType === gstRegType
  );
  const approveBlocked = !classificationComplete || !classificationPersisted;
  // The Save button's ✓-saved label is DERIVED (current selection === persisted), so reverting
  // a dirty edit back to the stored value clears "Saved" in lock-step with Approve re-enabling.
  const classificationSaved = classificationComplete && classificationPersisted;

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/admin/kyc"
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-lg font-bold text-gray-900">{kyc.outletName}</h1>
            <p className="text-xs text-gray-500">Outlet ID: <span className="font-mono">{kyc.outletCode || '—'}</span> · Submitted: {kyc.submittedDate}</p>
            {kyc.addressNameMismatch && (
              <span
                data-testid="address-name-mismatch-badge"
                className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full"
              >
                <AlertTriangle className="w-3 h-3" />
                Names differ — shop board vs address proof
              </span>
            )}
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

      {actionError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-2 text-sm text-red-700">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {actionError}
        </div>
      )}

      {/* Re-KYC staged changes: the live partner fields still hold the OLD values; the NEW
          (proposed) values below are what approval will apply. Surface up-front so the
          reviewer never approves stale identity/payout data. */}
      {kyc.proposedChanges && (
        <div
          data-testid="proposed-changes-banner"
          className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-2 text-sm"
        >
          <RefreshCw className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="font-semibold text-amber-800">Re-KYC — proposed changes awaiting approval</p>
            <p className="text-amber-700 text-xs mt-0.5">
              The values below marked <span className="font-medium">Proposed change</span> are the NEW values
              approval will apply (the previous value is shown as &ldquo;was …&rdquo;). Changed:{' '}
              <span className="font-medium">
                {(Object.keys(kyc.proposedChanges) as ProposedFieldKey[])
                  .map((k) => PROPOSED_FIELD_LABELS[k]).join(', ')}
              </span>
            </p>
          </div>
        </div>
      )}

      {/* Wave-4 group-leave (Option A): the proposed PAN differs from the outlet's owner-group
          PAN, so approving this re-KYC DETACHES the shop from its group. Distinct red/amber
          warning — clearly separate from the amber "Proposed change" banner above — so the
          reviewer knows the approval re-establishes the shop as an independent outlet. */}
      {kyc.willLeaveGroup && (
        <div
          data-testid="group-leave-banner"
          className="bg-red-50 border border-red-300 rounded-xl p-4 flex items-start gap-2 text-sm"
        >
          <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="font-semibold text-red-800">Approving this re-KYC removes the shop from its owner group</p>
            <p className="text-red-700 text-xs mt-0.5">
              The proposed PAN differs from the group&rsquo;s PAN. Approving changes the shop&rsquo;s PAN
              and will <span className="font-semibold">remove it from its owner group</span>, re-establishing
              it as an independent shop.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left column */}
        <div className="space-y-4">
          {/* Partner Info */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-[var(--brand-primary)]" />
              Partner Information
            </h2>
            <div className="space-y-2.5 text-xs">
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Firm Name</span>
                <span className="text-gray-800 font-medium">
                  <ProposedFieldValue change={kyc.proposedChanges?.businessName}>{kyc.firmName}</ProposedFieldValue>
                  <VerifiedOnParentBadge verified={kyc.parentVerified?.businessName} />
                </span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Owner Name</span>
                <span className="text-gray-800 font-medium">
                  <ProposedFieldValue change={kyc.proposedChanges?.ownerName}>{kyc.ownerName || '—'}</ProposedFieldValue>
                  <VerifiedOnParentBadge verified={kyc.parentVerified?.ownerName} />
                </span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Class</span>
                <span className="text-amber-700 font-semibold bg-amber-50 px-2 py-0.5 rounded-full">{kyc.partnerClass}</span>
              </div>
              <div className="flex gap-2 items-center">
                <span className="text-gray-500 w-24 flex-shrink-0">Mobile</span>
                <span className="flex items-center gap-1 text-gray-800">
                  <Phone className="w-3 h-3" />
                  <ProposedFieldValue change={kyc.proposedChanges?.phone}>{kyc.mobile}</ProposedFieldValue>
                  <VerifiedOnParentBadge verified={kyc.parentVerified?.phone} />
                </span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Email</span>
                <span className="text-gray-800">{kyc.email}</span>
              </div>
              <div className="flex gap-2 items-start">
                <span className="text-gray-500 w-24 flex-shrink-0">Address</span>
                <span className="text-gray-800">
                  <ProposedFieldValue change={kyc.proposedChanges?.address}>
                    {[kyc.address, kyc.city, kyc.state, kyc.pincode].filter(Boolean).join(', ') || '—'}
                  </ProposedFieldValue>
                </span>
              </div>
              {(() => {
                // KYC-captured geo: store-board location preferred, payment-capture fallback.
                const geo = kyc.boardGeo ?? kyc.paymentGeo;
                return geo ? (
                  <div className="flex gap-2 items-start" data-testid="kyc-location">
                    <span className="text-gray-500 w-24 flex-shrink-0">Location</span>
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${geo.lat},${geo.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-700 font-mono underline decoration-dotted underline-offset-2 hover:text-emerald-800"
                    >
                      {geo.lat.toFixed(6)}, {geo.lng.toFixed(6)}
                    </a>
                  </div>
                ) : null;
              })()}
            </div>
          </div>

          {/* Tax Info */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4 text-[var(--brand-primary)]" />
              Tax & Registration
            </h2>
            <div className="space-y-2 text-xs">
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">PAN</span>
                <span className="font-mono text-gray-800 font-medium">
                  <ProposedFieldValue change={kyc.proposedChanges?.panNumber} mono>{kyc.panNumber || '—'}</ProposedFieldValue>
                  <VerifiedOnParentBadge verified={kyc.parentVerified?.panNumber} />
                </span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">GSTIN</span>
                <span className="font-mono text-gray-800 font-medium">
                  <ProposedFieldValue change={kyc.proposedChanges?.gstNumber} mono>{kyc.gstNumber || '—'}</ProposedFieldValue>
                  <VerifiedOnParentBadge verified={kyc.parentVerified?.gstNumber} />
                </span>
              </div>
            </div>

            {/* ── Gifsy Admin classification — compulsory before approval ── */}
            <div className="mt-4 pt-4 border-t border-gray-100" data-testid="classification-section">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Classification · Set by Gifsy Admin
              </p>
              <div className="space-y-3">
                {/* Entity Type */}
                <div>
                  <label htmlFor="kyc-entity-type" className="block text-xs text-gray-500 mb-1">Entity Type</label>
                  <select
                    id="kyc-entity-type"
                    data-testid="entity-type-select"
                    value={entityType}
                    disabled={Boolean(classificationLock) || savingClassification}
                    onChange={(e) => setEntityType(e.target.value as EntityType)}
                    className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-2 bg-white text-gray-800 disabled:bg-gray-50 disabled:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30 focus:border-[var(--brand-primary)]"
                  >
                    <option value="" disabled>— Select —</option>
                    {(Object.keys(ENTITY_TYPE_LABELS) as EntityType[]).map((k) => (
                      <option key={k} value={k}>{ENTITY_TYPE_LABELS[k]}</option>
                    ))}
                  </select>
                </div>

                {/* GST Registration Type */}
                <div>
                  <label htmlFor="kyc-gst-reg-type" className="block text-xs text-gray-500 mb-1">GST Registration Type</label>
                  <select
                    id="kyc-gst-reg-type"
                    data-testid="gst-reg-type-select"
                    value={gstRegType}
                    disabled={Boolean(classificationLock) || savingClassification}
                    onChange={(e) => setGstRegType(e.target.value as GSTRegistrationType)}
                    className="w-full text-xs border border-gray-200 rounded-lg px-2.5 py-2 bg-white text-gray-800 disabled:bg-gray-50 disabled:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/30 focus:border-[var(--brand-primary)]"
                  >
                    <option value="" disabled>— Select —</option>
                    {(Object.keys(GST_REG_LABELS) as GSTRegistrationType[]).map((k) => (
                      <option key={k} value={k}>{GST_REG_LABELS[k]}</option>
                    ))}
                  </select>
                  {gstRegType === 'REGULAR' && (
                    <p className="text-[10px] text-green-600 mt-1">
                      GST will be applied to visibility invoices for this retailer.
                    </p>
                  )}
                  {(gstRegType === 'UNREGISTERED' || gstRegType === 'COMPOSITE') && (
                    <p className="text-[10px] text-gray-400 mt-1">
                      Invoices for this retailer will not include GST.
                    </p>
                  )}
                </div>

                {classificationLock ? (
                  // Group-inherited: authoritative from the owner group — locked, no save action.
                  <p
                    data-testid="classification-lock-note"
                    className="text-[10px] text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-2"
                  >
                    🔒 Inherited from group — one registration/entity type per organization (cannot be changed here).
                  </p>
                ) : (
                  <>
                    <button
                      data-testid="save-classification-btn"
                      onClick={handleSaveClassification}
                      disabled={!classificationComplete || classificationSaved || savingClassification}
                      className="w-full text-xs py-1.5 rounded-lg border border-[var(--brand-primary)] text-[var(--brand-primary)] hover:bg-green-50 disabled:opacity-50 disabled:hover:bg-transparent transition-colors font-medium flex items-center justify-center gap-1.5"
                    >
                      {savingClassification && <RefreshCw className="w-3 h-3 animate-spin" />}
                      {savingClassification
                        ? 'Saving…'
                        : classificationSaved ? '✓ Classification Saved' : 'Save Classification'}
                    </button>
                    {classificationError && (
                      <p
                        data-testid="classification-error"
                        className="text-[10px] text-red-600 flex items-center gap-1"
                      >
                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />{classificationError}
                      </p>
                    )}
                    {/* Visible, reachable copy of the approve gate (a disabled button isn't
                        announced to screen readers) — sits right by the Classification controls. */}
                    {approveBlocked && (
                      <p
                        data-testid="classification-approve-hint"
                        className="text-[10px] text-amber-700 flex items-start gap-1"
                      >
                        <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                        Set &amp; save Entity Type and GST Registration Type before approving.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Bank Details */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-[var(--brand-primary)]" />
              Bank Details
              {kyc.requiredPaymentType && REQUIRED_PAYMENT_LABELS[kyc.requiredPaymentType] && (
                <span
                  data-testid="required-payout-pill"
                  className="ml-auto text-[11px] font-semibold text-gray-600 bg-gray-100 border border-gray-200 px-2 py-0.5 rounded-full"
                >
                  Required payout: {REQUIRED_PAYMENT_LABELS[kyc.requiredPaymentType]}
                </span>
              )}
            </h2>
            <div className="space-y-2 text-xs">
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Bank</span>
                <span className="text-gray-800 font-medium">
                  <ProposedFieldValue change={kyc.proposedChanges?.bankName}>{kyc.bankName}</ProposedFieldValue>
                  <VerifiedOnParentBadge verified={kyc.parentVerified?.bankName} />
                </span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">Account No.</span>
                <span className="font-mono text-gray-800">
                  <ProposedFieldValue change={kyc.proposedChanges?.bankAccountNumber} mono>{kyc.accountNumber}</ProposedFieldValue>
                  <VerifiedOnParentBadge verified={kyc.parentVerified?.bankAccountNumber} />
                </span>
              </div>
              {/* Account Holder — no standing row; surfaced only when a re-KYC stages a change. */}
              {kyc.proposedChanges?.bankAccountHolder && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-24 flex-shrink-0">Acct Holder</span>
                  <span className="text-gray-800">
                    <ProposedFieldValue change={kyc.proposedChanges.bankAccountHolder}>—</ProposedFieldValue>
                    <VerifiedOnParentBadge verified={kyc.parentVerified?.bankAccountHolder} />
                  </span>
                </div>
              )}
              <div className="flex gap-2">
                <span className="text-gray-500 w-24 flex-shrink-0">IFSC</span>
                <span className="font-mono text-gray-800">
                  <ProposedFieldValue change={kyc.proposedChanges?.ifscCode} mono>{kyc.ifscCode}</ProposedFieldValue>
                  <VerifiedOnParentBadge verified={kyc.parentVerified?.ifscCode} />
                </span>
              </div>
              {(kyc.upiId || kyc.proposedChanges?.upiId) && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-24 flex-shrink-0">UPI ID</span>
                  <span className="font-mono text-gray-800">
                    <ProposedFieldValue change={kyc.proposedChanges?.upiId} mono>{kyc.upiId}</ProposedFieldValue>
                    <VerifiedOnParentBadge verified={kyc.parentVerified?.upiId} />
                  </span>
                </div>
              )}
              {/* Payment Mode — no standing row; surfaced only when a re-KYC stages a change. */}
              {kyc.proposedChanges?.paymentMode && (
                <div className="flex gap-2">
                  <span className="text-gray-500 w-24 flex-shrink-0">Payment Mode</span>
                  <span className="text-gray-800">
                    <ProposedFieldValue change={kyc.proposedChanges.paymentMode}>—</ProposedFieldValue>
                  </span>
                </div>
              )}
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
              <MapPin className="w-4 h-4 text-[var(--brand-primary)]" />
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
              flaggedDocTypes={hasReKycFlags(kyc.reKycFlags) ? flaggedDocTypes(kyc.reKycFlags) : undefined}
              flaggedLabels={hasReKycFlags(kyc.reKycFlags) ? flaggedLabels(kyc.reKycFlags) : undefined}
              reKycRemarks={reKycRemarks(kyc.reKycFlags) || undefined}
              approveDisabled={approveBlocked}
              approveDisabledReason="Set & save Entity Type and GST Registration Type before approving."
            />
          </div>

          {/* Per-field KYC verification — wired to POST /api/kyc/:id/verify */}
          <KycFieldVerificationPanel submissionId={kyc.id} initialItems={kyc.verificationItems} />

          {/* Status History Timeline */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-4 flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--brand-primary)]" />
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
              <FileText className="w-4 h-4 text-[var(--brand-primary)]" />
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
