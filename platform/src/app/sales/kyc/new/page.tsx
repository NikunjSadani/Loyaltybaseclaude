'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, User, MapPin, CreditCard, Check,
  FileText, Upload, X, AlertCircle, ImageIcon,
  Search, Building2, ChevronDown, Phone,
  Camera, Navigation, Loader2, RefreshCw,
  PenLine, ShieldCheck, FileDown,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BankOrUpiSection, type PaymentMode } from '@/components/bank-or-upi-section';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { isValidUpiId } from '@/lib/upi-utils';
import { INDIAN_STATES } from '@/lib/indian-states';
import { isValidGstin, panFromGstin, GSTIN_LENGTH } from '@/lib/gstin';
import {
  hasReKycFlags, isReKycActionable, reKycRemarks, flaggedLabels,
  isWizardFieldFlagged, isWizardFieldEditable,
} from '@/lib/rekyc-fields';
import type { GeoCapture } from '@/types';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

type Step = 'outlet' | 'basic' | 'address' | 'bank' | 'otp' | 'done';

interface AssignedOutlet {
  /** Internal identity (Prisma CUID) — used as the select key + the Not-Interested POST id. NOT shown to users. */
  outletId: string;
  /** Human-readable outlet code (e.g. OUT-2026-003) — the value shown in the UI. */
  outletCode: string;
  name: string;
  beat: string;
  type: 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';
  programName?: string;
  programCategory?: string;
  /** Present for re-entry outlets (rejected/resubmission/re-KYC) and approved */
  kycStatus?:    'APPROVED' | 'RE_KYC_REQUIRED' | 'REJECTED' | 'RE_UPLOAD_REQUIRED' | 'RESUBMISSION_REQUIRED' | 'DRAFT';
  /** The REAL latest KYC status from the API (NOT_STARTED / SUBMITTED / PENDING_GIFSY /
   *  APPROVED / …). Drives the picker filter: only never-submitted outlets are
   *  manually selectable for a NEW KYC. (Re-entry of rejected/re-KYC outlets comes via
   *  the KYC list's "Edit & Resubmit" deep-link, which bypasses this filter.) */
  rawStatus?:    string;
  /** Latest KYC submission id (for deep-link / reference) */
  kycId?:        string;
  /** Fields that must be re-captured; keys match form field names */
  reKycFlags?:   Partial<Record<string, boolean>>;
  /** Existing KYC data — pre-fills the form for Re-KYC outlets */
  existingKyc?:  {
    partnerName: string; mobile: string; gstNumber: string; panNumber: string;
    address: string; city: string; state: string; pincode: string;
    bankName: string; accountHolderName: string; accountNumber: string; ifscCode: string; upiId: string;
  };
  reKycRemarks?: string;
}

/** Upload state for a single KYC document slot */
type DocUploadState = 'idle' | 'uploading' | 'uploaded' | 'error';

interface UploadedFile {
  name: string;
  size: number;
  type: string;
  /** Local preview only — dataUrl from canvas/compression; NOT sent on submit */
  dataUrl: string;
  /** GCS-backed fields — set after POST /api/kyc/documents succeeds */
  fileKey?: string;
  fileUrl?: string;
  /** Server-returned canonical filename (may differ from local name after compression) */
  fileName?: string;
  mimeType?: string;
  fileSizeBytes?: number;
  uploadState: DocUploadState;
  uploadError?: string;
  /** True when this slot was pre-filled from the previous (rejected/re-KYC)
   *  submission rather than freshly uploaded this session. */
  carriedOver?: boolean;
}

/* ─── Constants ──────────────────────────────────────────────────────────────── */

const MAX_FILE_BYTES    = 5 * 1024 * 1024;
const COMPRESS_QUALITY  = 0.82;
const COMPRESS_MAX_DIM  = 1920;


const TYPE_LABEL: Record<AssignedOutlet['type'], string> = {
  SSS: 'SSS', WHOLESALER: 'Wholesaler', SUB_STOCKIST: 'Sub-Stockist',
};


type MobileCheckState = 'idle' | 'checking' | 'ok' | 'outlet_conflict' | 'employee_conflict';

/* ─── Step config ────────────────────────────────────────────────────────────── */

/** Steps shown in the step bar — otp and done are post-submission */
const STEPS: Step[] = ['outlet', 'basic', 'address', 'bank'];
const STEP_LABELS: Record<Step, string> = {
  outlet: 'Outlet', basic: 'Details', address: 'Address', bank: 'Bank', otp: 'OTP', done: 'Done',
};

/* ─── Image compression ──────────────────────────────────────────────────────── */

async function compressFile(file: File): Promise<{ dataUrl: string; size: number; type: string } | null> {
  if (file.size > MAX_FILE_BYTES) return null;
  if (!file.type.startsWith('image/')) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ dataUrl: reader.result as string, size: file.size, type: file.type });
      reader.readAsDataURL(file);
    });
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > COMPRESS_MAX_DIM || height > COMPRESS_MAX_DIM) {
          const scale = COMPRESS_MAX_DIM / Math.max(width, height);
          width  = Math.round(width  * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', COMPRESS_QUALITY);
        const size    = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
        resolve({ dataUrl, size, type: 'image/jpeg' });
      };
      img.src = ev.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
}

/* ─── KYC document type mapping ──────────────────────────────────────────────── */

type DocKey = 'businessDoc' | 'ownerPhoto' | 'shopAddressDoc' | 'storeBoardPhoto' | 'cheque' | 'selfDeclaration';

const DOC_TYPE_MAP: Record<DocKey, string> = {
  businessDoc:     'GST_CERTIFICATE',
  ownerPhoto:      'SELFIE',
  shopAddressDoc:  'SHOP_ESTABLISHMENT',
  storeBoardPhoto: 'STORE_BOARD_PHOTO',
  cheque:          'CANCELLED_CHEQUE',
  selfDeclaration: 'SELF_DECLARATION',
};

/** documentType → form slot key — reverse of DOC_TYPE_MAP, used to re-fill the
 *  document/photo slots from a previous submission on re-entry (resubmit / re-KYC). */
const DOC_TYPE_TO_KEY: Record<string, DocKey> = Object.fromEntries(
  Object.entries(DOC_TYPE_MAP).map(([k, v]) => [v, k as DocKey]),
) as Record<string, DocKey>;

/** Statuses for which the SAME outlet's KYC is re-opened pre-filled. */
const RE_ENTRY_STATUSES = new Set(['REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED', 'RE_KYC_REQUIRED', 'DRAFT']);

/* ─── GCS upload helper ───────────────────────────────────────────────────────── */

interface GcsUploadResult {
  fileKey: string;
  fileUrl: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
}

async function uploadDocToGCS(
  blob: Blob,
  fileName: string,
  docKey: DocKey,
): Promise<GcsUploadResult> {
  const formData = new FormData();
  formData.append('file', blob, fileName);
  formData.append('documentType', DOC_TYPE_MAP[docKey]);

  const res = await fetch('/api/kyc/documents', {
    method: 'POST',
    body: formData,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    throw new Error(body.message ?? body.error ?? `Upload failed (${res.status})`);
  }
  return body.data as GcsUploadResult;
}

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function NewKYCPage() {
  const router = useRouter();
  const [step,       setStep]       = useState<Step>('outlet');
  const [submitting, setSubmitting] = useState(false);

  /* Outlet */
  const [selectedOutlet, setSelectedOutlet] = useState<AssignedOutlet | null>(null);
  const [outletSearch,   setOutletSearch]   = useState('');
  const [dropOpen,       setDropOpen]       = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  /* Assigned outlets (from API) */
  const [assignedOutlets, setAssignedOutlets] = useState<AssignedOutlet[]>([]);
  const [registeredPhones, setRegisteredPhones] = useState<Map<string, { name: string; outletCode: string }>>(new Map());

  /* Not Interested flow */
  const [confirmNotInterestedId, setConfirmNotInterestedId] = useState<string | null>(null);
  const [notInterestedLoading,   setNotInterestedLoading]   = useState(false);
  const [dismissedOutlets,       setDismissedOutlets]       = useState<Set<string>>(new Set());
  const [notInterestedToast,     setNotInterestedToast]     = useState<string | null>(null); // name of last dismissed

  /* Phone conflict check (no inline OTP — OTP happens post-submit) */
  const [mobileCheck,    setMobileCheck]    = useState<MobileCheckState>('idle');
  const [mobileCheckMsg, setMobileCheckMsg] = useState('');

  /* Geo capture #1 — board photo (taken when store board photo is captured) */
  const [boardPhotoGeo,        setBoardPhotoGeo]        = useState<GeoCapture | null>(null);
  const [boardPhotoGeoLoading, setBoardPhotoGeoLoading] = useState(false);
  const [boardPhotoGeoError,   setBoardPhotoGeoError]   = useState('');

  /* Geo capture #2 — payment (taken when cheque uploaded or QR scanned) */
  const [paymentGeo,        setPaymentGeo]        = useState<GeoCapture | null>(null);
  const [paymentGeoLoading, setPaymentGeoLoading] = useState(false);
  const [paymentGeoError,   setPaymentGeoError]   = useState('');

  /* Form fields */
  const [form, setForm] = useState({
    partnerName: '', mobile: '', partnerClass: 'SSS' as AssignedOutlet['type'],
    gstNumber: '', panNumber: '', address: '', city: '', state: '', pincode: '',
    bankName: '', accountHolderName: '', accountNumber: '', ifscCode: '', upiId: '',
  });

  /* KYC submission ID (stored after successful POST /api/kyc) */
  const [submissionId, setSubmissionId] = useState<string | null>(null);

  /* Bank vs UPI toggle */
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('bank');

  /* Docs */
  type DocsState = {
    businessDoc:      UploadedFile | null;
    ownerPhoto:       UploadedFile | null;
    shopAddressDoc:   UploadedFile | null;
    storeBoardPhoto:  UploadedFile | null;
    cheque:           UploadedFile | null;
    selfDeclaration:  UploadedFile | null;
  };
  const [docs, setDocs] = useState<DocsState>({ businessDoc: null, ownerPhoto: null, shopAddressDoc: null, storeBoardPhoto: null, cheque: null, selfDeclaration: null });

  /* File refs */
  const businessDocRef       = useRef<HTMLInputElement>(null);
  const shopAddressDocRef    = useRef<HTMLInputElement>(null);
  const chequeRef            = useRef<HTMLInputElement>(null);
  const selfDeclarationRef   = useRef<HTMLInputElement>(null);

  /* Camera */
  const [cameraDocKey, setCameraDocKey] = useState<'ownerPhoto' | 'storeBoardPhoto' | null>(null);
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('environment');
  const [cameraErr,    setCameraErr]    = useState('');
  const [capturing,    setCapturing]    = useState(false);
  const videoRef  = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  /* Address name mismatch flag */
  const [nameMismatch, setNameMismatch] = useState(false);

  /* B — Consent checkboxes */
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [agreedToComms, setAgreedToComms] = useState(false);

  /* C — Signature pad */
  const signatureCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing,  setIsDrawing]  = useState(false);
  const [hasSigned,  setHasSigned]  = useState(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  /* Signature carried over from the previous submission — drawn onto the canvas
   *  once the Bank step (where the pad mounts) renders. */
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);
  /* True once a previous signature has been carried over (drives the "reused" hint;
   *  cleared when the rep clears the pad to re-sign). */
  const [signatureCarriedOver, setSignatureCarriedOver] = useState(false);
  /* Guards the re-entry prefill so it fetches+fills a given submission only once
   *  (re-running would clobber the rep's edits). */
  const prefilledKycRef = useRef<string | null>(null);

  /* D — Post-submit OTP */
  const [submitOtp,          setSubmitOtp]          = useState('');
  const [submitOtpError,     setSubmitOtpError]     = useState('');
  const [submitOtpVerifying, setSubmitOtpVerifying] = useState(false);
  const [submitOtpCountdown, setSubmitOtpCountdown] = useState(0);
  /** Submit/OTP-send failure shown on the form (e.g. duplicate/employee phone) */
  const [submitError,        setSubmitError]        = useState('');

  /* File error */
  const [fileError, setFileError] = useState('');

  /* ── Load assigned outlets from API ── */
  useEffect(() => {
    fetch('/api/sales/outlets')
      .then((r) => r.json())
      .then((body) => {
        if (body.success) {
          const RE_ENTRY = ['RE_KYC_REQUIRED', 'REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED', 'DRAFT'];
          const outlets: AssignedOutlet[] = (body.data.outlets ?? []).map((o: any) => ({
            outletId:   o.id,
            outletCode: o.outletCode ?? o.id, // human code for display; fall back to id if ever absent
            name:       o.name,
            beat:       o.beat || o.district || '',
            type:       (o.type ?? 'SSS') as AssignedOutlet['type'],
            // Pass through the real status for any re-entry status so the wizard
            // pre-fills; otherwise leave undefined (NOT_STARTED outlets etc.).
            kycStatus:    RE_ENTRY.includes(o.kycStatus) ? o.kycStatus : undefined,
            // The REAL status (unfiltered) — drives the "startable" picker filter below.
            rawStatus:    o.kycStatus ?? 'NOT_STARTED',
            kycId:        o.kycId,
            existingKyc:  o.existingKyc ?? undefined,
            reKycFlags:   o.reKycFlags ?? undefined,
            reKycRemarks: o.kycRejectionReason ?? o.reKycFlags?.remarks ?? undefined,
            programName:     o.programName ?? '',
            programCategory: o.programCategory ?? '',
          }));
          setAssignedOutlets(outlets);
          // Build registered phones map from outlet mobiles for conflict detection
          const phones = new Map<string, { name: string; outletCode: string }>();
          (body.data.outlets ?? []).forEach((o: any) => {
            if (o.mobile) {
              const normalized = String(o.mobile).replace(/^(\+91|91)/, '');
              phones.set(normalized, { name: o.name, outletCode: o.outletCode ?? o.id });
            }
          });
          setRegisteredPhones(phones);
        }
      })
      .catch(() => {});
  }, []);

  /* ── Deep-link: ?outletId=<id> auto-selects that assigned outlet once loaded ── */
  useEffect(() => {
    if (typeof window === 'undefined' || selectedOutlet) return;
    const outletId = new URLSearchParams(window.location.search).get('outletId');
    if (!outletId) return;
    const match = assignedOutlets.find((o) => o.outletId === outletId);
    if (!match) return;
    setSelectedOutlet(match);
    // Re-KYC deep-link: the outlet is already chosen AND 'Not Interested' is hidden
    // for a RE_KYC_REQUIRED outlet (see the outlet step), so Step 1 (Select Outlet)
    // has no decision left to make — skip straight to Details and mark outlet-select
    // done. Rejected / resubmission deep-links KEEP Step 1 because the rep can still
    // mark those Not Interested there.
    if (match.kycStatus === 'RE_KYC_REQUIRED') setStep('basic');
  }, [assignedOutlets, selectedOutlet]);

  /* ── Outside-click: outlet dropdown ── */
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setDropOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  /* ── OTP resend countdown ── */
  useEffect(() => {
    if (submitOtpCountdown <= 0) return;
    const t = setInterval(() => setSubmitOtpCountdown((c) => c - 1), 1000);
    return () => clearInterval(t);
  }, [submitOtpCountdown]);

  /* Derived: is this a re-entry (re-KYC / rejected / resubmission) flow?
   * Also fires when the outlet carries admin re-KYC FIELD FLAGS even if its
   * submission status is APPROVED (a bulk / field-level re-KYC request on a live
   * outlet) — so such an outlet enters the locked-edit mode below. */
  const isReKYC = !!selectedOutlet && (
    ['RE_KYC_REQUIRED', 'REJECTED', 'RE_UPLOAD_REQUIRED', 'RESUBMISSION_REQUIRED', 'DRAFT'].includes(selectedOutlet.kycStatus as string) ||
    // Flags persist through review, so gate on "actionable" (not under review) — else a
    // resubmitted outlet would re-enter locked-edit mode while its submission is in flight.
    isReKycActionable(selectedOutlet.reKycFlags, selectedOutlet.rawStatus)
  );

  /** True when a wizard field/doc slot (by its wizard key) is flagged for re-capture.
   *  Delegates to the canonical map so the amber highlight uses the RIGHT reKycFlags
   *  keys (fixes the old mobile/GST-cert/shop-doc mismatches). */
  const isReKYCFlagged = (wizardKey: string) => isWizardFieldFlagged(selectedOutlet?.reKycFlags, wizardKey);

  /** On re-entry with specific field flags, every NON-flagged mapped field/doc is
   *  LOCKED (disabled but pre-filled). A blanket re-KYC (no field flags) or a
   *  first-time KYC keeps everything editable. */
  const isFieldLocked = (wizardKey: string) => !isWizardFieldEditable(selectedOutlet?.reKycFlags, wizardKey);

  /* ── Pre-fill partner class from outlet ── */
  useEffect(() => {
    if (selectedOutlet) setForm((f) => ({ ...f, partnerClass: selectedOutlet.type }));
  }, [selectedOutlet]);

  /* ── Pre-fill existing KYC data when a Re-KYC outlet is selected ── */
  useEffect(() => {
    if (!selectedOutlet?.existingKyc) return;
    const k = selectedOutlet.existingKyc;
    setForm((f) => ({
      ...f,
      partnerName:   k.partnerName,
      mobile:        k.mobile,
      gstNumber:     k.gstNumber,
      panNumber:     k.panNumber,
      address:       k.address,
      city:          k.city,
      state:         k.state,
      pincode:       k.pincode,
      bankName:      k.bankName,
      accountHolderName: k.accountHolderName,
      accountNumber: k.accountNumber,
      ifscCode:      k.ifscCode,
      upiId:         k.upiId,
    }));
    // Trigger mobile-conflict check for the pre-filled number
    if (k.mobile.length === 10) setMobileCheck('ok');
  }, [selectedOutlet]);

  /* ── Reset all captured/carried-over evidence whenever the SELECTED OUTLET changes,
   *     so one outlet's documents/photos/geo/signature can NEVER bleed into another
   *     outlet's submission (the rep can switch outlets on the picker mid-flow).
   *     Keyed on outletId so re-selecting the SAME outlet preserves the rep's edits.
   *     Declared BEFORE the prefill effect so it runs first on an outlet change. ── */
  const lastOutletIdRef = useRef<string | null>(null);
  useEffect(() => {
    const oid = selectedOutlet?.outletId ?? null;
    if (lastOutletIdRef.current === oid) return; // same outlet → keep the rep's edits
    lastOutletIdRef.current = oid;
    setDocs({ businessDoc: null, ownerPhoto: null, shopAddressDoc: null, storeBoardPhoto: null, cheque: null, selfDeclaration: null });
    setBoardPhotoGeo(null); setBoardPhotoGeoError(''); setBoardPhotoGeoLoading(false);
    setPaymentGeo(null); setPaymentGeoError(''); setPaymentGeoLoading(false);
    setPendingSignature(null); setSignatureCarriedOver(false); setHasSigned(false);
    const canvas = signatureCanvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    prefilledKycRef.current = null; // re-arm the prefill for the new outlet
  }, [selectedOutlet?.outletId]);

  /* ── Re-entry: pre-fill the DOCUMENTS, PHOTOS, geo + signature from the previous
   *     (rejected / re-KYC) submission so the rep edits only what's needed, instead
   *     of re-uploading everything. Fetches the one submission (GET /api/kyc/:id —
   *     which already inlines each doc as a data URL) on outlet selection, once. ── */
  useEffect(() => {
    const kycId  = selectedOutlet?.kycId;
    const status = selectedOutlet?.kycStatus ?? '';
    if (!kycId || !RE_ENTRY_STATUSES.has(status)) return;
    if (prefilledKycRef.current === kycId) return; // fill a given submission only once
    prefilledKycRef.current = kycId;

    (async () => {
      try {
        const res = await fetch(`/api/kyc/${kycId}`);
        const body = await res.json().catch(() => ({ success: false }));
        if (!body?.success || !body.data?.submission) return;
        const sub = body.data.submission as {
          documents?: Array<{
            documentType: string; fileKey?: string; fileUrl?: string; viewUrl?: string | null;
            fileName?: string | null; mimeType?: string | null; fileSizeBytes?: number | null;
          }>;
          boardPhotoLat?: string | number | null; boardPhotoLng?: string | number | null;
          boardPhotoGeoAccuracy?: string | number | null; boardPhotoGeoAt?: string | null;
          paymentLat?: string | number | null; paymentLng?: string | number | null;
          paymentGeoAccuracy?: string | number | null; paymentGeoAt?: string | null;
        };

        // Documents + photos → form slots. SIGNATURE is handled via the pad below.
        const nextDocs: Partial<Record<DocKey, UploadedFile>> = {};
        for (const d of sub.documents ?? []) {
          if (d.documentType === 'SIGNATURE') {
            if (d.viewUrl) { setPendingSignature(d.viewUrl); setSignatureCarriedOver(true); }
            continue;
          }
          const key = DOC_TYPE_TO_KEY[d.documentType];
          // Only carry over real GCS-backed docs we can both preview (viewUrl) and
          // re-reference on resubmit (fileKey + fileUrl). pending:// / unmapped → skip.
          if (!key || !d.viewUrl || !d.fileKey || !d.fileUrl) continue;
          nextDocs[key] = {
            name:          d.fileName ?? d.documentType,
            size:          d.fileSizeBytes ?? 0,
            type:          d.mimeType ?? 'image/jpeg',
            dataUrl:       d.viewUrl,            // inlined preview
            fileKey:       d.fileKey,            // resubmit reuses the same GCS object
            fileUrl:       d.fileUrl,
            fileName:      d.fileName ?? undefined,
            mimeType:      d.mimeType ?? undefined,
            fileSizeBytes: d.fileSizeBytes ?? undefined,
            uploadState:   'uploaded',
            carriedOver:   true,
          };
        }
        if (Object.keys(nextDocs).length) setDocs((cur) => ({ ...cur, ...nextDocs }));

        // Carry over the geo proofs so the rep isn't forced back on-site to re-shoot
        // a photo that was fine (the store hasn't moved). A fresh re-take re-captures.
        // Prisma Decimal columns arrive as strings → coerce; reject NaN so a bad value
        // can't poison the geo (Number.isFinite, not `?? 0`, which lets NaN through).
        const fin = (v: unknown): number | null => {
          if (v == null) return null;
          const n = Number(v);
          return Number.isFinite(n) ? n : null;
        };
        const lat1 = fin(sub.boardPhotoLat), lng1 = fin(sub.boardPhotoLng);
        if (lat1 != null && lng1 != null) {
          setBoardPhotoGeo({
            lat: lat1, lng: lng1,
            accuracy: Math.round(fin(sub.boardPhotoGeoAccuracy) ?? 0),
            ts: sub.boardPhotoGeoAt ?? new Date().toISOString(),
          });
        }
        const lat2 = fin(sub.paymentLat), lng2 = fin(sub.paymentLng);
        if (lat2 != null && lng2 != null) {
          setPaymentGeo({
            lat: lat2, lng: lng2,
            accuracy: Math.round(fin(sub.paymentGeoAccuracy) ?? 0),
            ts: sub.paymentGeoAt ?? new Date().toISOString(),
          });
        }
      } catch {
        // Best-effort prefill — a failure just means the rep re-uploads (text fields
        // + remark still pre-fill from the outlets list payload).
        prefilledKycRef.current = null; // allow a retry on re-selection
      }
    })();
  }, [selectedOutlet]);

  /* Draw a carried-over signature onto the pad once the Bank step mounts it. */
  useEffect(() => {
    if (step !== 'bank' || !pendingSignature || hasSigned) return;
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      setHasSigned(true);
      setPendingSignature(null);
    };
    img.src = pendingSignature;
  }, [step, pendingSignature, hasSigned]);

  /* ── Geo capture helpers ── */
  const captureBoardPhotoGeo = useCallback(() => {
    if (!navigator.geolocation) { setBoardPhotoGeoError('Geolocation not supported on this device.'); return; }
    setBoardPhotoGeoLoading(true); setBoardPhotoGeoError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBoardPhotoGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy), ts: new Date().toISOString() });
        setBoardPhotoGeoLoading(false);
      },
      () => {
        setBoardPhotoGeoError('Location access denied — please enable location and retake the store board photo.');
        setBoardPhotoGeoLoading(false);
      },
      { timeout: 12000, maximumAge: 0 },
    );
  }, []);

  const capturePaymentGeo = useCallback(() => {
    if (!navigator.geolocation) { setPaymentGeoError('Geolocation not supported on this device.'); return; }
    setPaymentGeoLoading(true); setPaymentGeoError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPaymentGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy), ts: new Date().toISOString() });
        setPaymentGeoLoading(false);
      },
      () => {
        setPaymentGeoError('Location access denied — please enable location to continue.');
        setPaymentGeoLoading(false);
      },
      { timeout: 12000, maximumAge: 0 },
    );
  }, []);

  /* ── Camera stream ── */
  useEffect(() => {
    if (!cameraDocKey) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      return;
    }
    setCameraErr('');
    let active = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: cameraFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => {}); }
      } catch {
        if (active) setCameraErr('Camera access denied or unavailable.');
      }
    })();
    return () => { active = false; };
  }, [cameraDocKey, cameraFacing]);

  /* ── Helpers ── */
  const set = (key: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleGSTChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // A real GSTIN is 15 chars; the embedded PAN is chars [2..11], available once
    // 12+ chars are entered. Below 12 we leave the existing PAN untouched.
    const gst = e.target.value.toUpperCase().slice(0, GSTIN_LENGTH);
    setForm((f) => ({ ...f, gstNumber: gst, panNumber: gst.length >= 12 ? panFromGstin(gst) : f.panNumber }));
  };

  /** Auto-run conflict check when 10 digits entered. No OTP here. */
  const handleMobileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 10);
    setForm((f) => ({ ...f, mobile: val }));
    setMobileCheck('idle'); setMobileCheckMsg('');

    if (val.length === 10) {
      setMobileCheck('checking');
      await new Promise((r) => setTimeout(r, 400));
      const existingOutlet = registeredPhones.get(val);
      if (existingOutlet) {
        setMobileCheck('outlet_conflict');
        setMobileCheckMsg(`Already registered to ${existingOutlet.name} (${existingOutlet.outletCode}). Each outlet must have a unique contact number.`);
        return;
      }
      // Real tenant-scoped employee uniqueness check (PII-free: backend returns
      // only { available, conflictType }). Fail OPEN on any network/parse error so
      // a transient failure never hard-blocks submit nor shows a false conflict.
      try {
        const res = await fetch(`/api/kyc/phone-available?phone=${val}`);
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.success && body.data?.available === false && body.data?.conflictType === 'EMPLOYEE') {
          setMobileCheck('employee_conflict');
          setMobileCheckMsg("This number is registered to a team member and can't be used for an outlet.");
          return;
        }
      } catch {
        // Fail open — ignore; do not block submit or assert an employee conflict.
      }
      setMobileCheck('ok');
    }
  };

  /* ── Camera helpers ── */
  const openCamera  = (docKey: 'ownerPhoto' | 'storeBoardPhoto', facing: 'user' | 'environment') => { setCameraFacing(facing); setCameraDocKey(docKey); };
  const closeCamera = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setCameraDocKey(null); setCameraErr(''); };
  const flipCamera  = () => setCameraFacing((f) => (f === 'user' ? 'environment' : 'user'));

  const capturePhoto = () => {
    if (!videoRef.current || !cameraDocKey) return;
    setCapturing(true);
    const video = videoRef.current;
    let { videoWidth: w, videoHeight: h } = video;
    if (w > COMPRESS_MAX_DIM || h > COMPRESS_MAX_DIM) {
      const scale = COMPRESS_MAX_DIM / Math.max(w, h);
      w = Math.round(w * scale); h = Math.round(h * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d')!.drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', COMPRESS_QUALITY);
    const size    = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
    const key     = cameraDocKey;
    const fileName = `${key}_${Date.now()}.jpg`;
    // Set preview immediately with uploading state
    setDocs((d) => ({ ...d, [key]: { name: fileName, size, type: 'image/jpeg', dataUrl, uploadState: 'uploading' } }));
    setCapturing(false);
    closeCamera();
    // Trigger geo capture #1 immediately after the board photo is taken
    if (key === 'storeBoardPhoto') {
      captureBoardPhotoGeo();
    }
    // Upload to GCS
    // Convert dataUrl to Blob for upload
    fetch(dataUrl)
      .then((r) => r.blob())
      .then((blob) => uploadDocToGCS(blob, fileName, key))
      .then((result) => {
        setDocs((d) => {
          const existing = d[key];
          if (!existing) return d;
          return {
            ...d,
            [key]: {
              ...existing,
              fileKey:       result.fileKey,
              fileUrl:       result.fileUrl,
              fileName:      result.fileName,
              mimeType:      result.mimeType,
              fileSizeBytes: result.fileSizeBytes,
              uploadState:   'uploaded' as DocUploadState,
              uploadError:   undefined,
            },
          };
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setDocs((d) => {
          const existing = d[key];
          if (!existing) return d;
          return { ...d, [key]: { ...existing, uploadState: 'error' as DocUploadState, uploadError: msg } };
        });
      });
  };

  /* ── File select ── */
  const handleFileSelect = useCallback(async (docKey: keyof DocsState, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setFileError('');
    if (file.size > MAX_FILE_BYTES) { setFileError(`"${file.name}" is ${formatBytes(file.size)} — max 5 MB.`); return; }
    const result = await compressFile(file);
    if (!result) return;
    // Set preview immediately with uploading state
    setDocs((d) => ({ ...d, [docKey]: { name: file.name, size: result.size, type: result.type, dataUrl: result.dataUrl, uploadState: 'uploading' } }));
    // Trigger geo capture #2 when the cancelled cheque is uploaded
    if (docKey === 'cheque') {
      capturePaymentGeo();
    }
    // Upload to GCS
    // Build a Blob from the compressed result to send (use original file for non-images, compressed jpeg for images)
    let uploadBlob: Blob;
    let uploadName: string;
    if (result.type === 'image/jpeg' && result.dataUrl.startsWith('data:')) {
      // Compressed image — convert dataUrl back to Blob
      uploadBlob = await fetch(result.dataUrl).then((r) => r.blob());
      uploadName = file.name.replace(/\.[^.]+$/, '.jpg');
    } else {
      // PDF or other non-image — upload original file
      uploadBlob = file;
      uploadName = file.name;
    }
    uploadDocToGCS(uploadBlob, uploadName, docKey as DocKey)
      .then((gcsResult) => {
        setDocs((d) => {
          const existing = d[docKey];
          if (!existing) return d;
          return {
            ...d,
            [docKey]: {
              ...existing,
              fileKey:       gcsResult.fileKey,
              fileUrl:       gcsResult.fileUrl,
              fileName:      gcsResult.fileName,
              mimeType:      gcsResult.mimeType,
              fileSizeBytes: gcsResult.fileSizeBytes,
              uploadState:   'uploaded' as DocUploadState,
              uploadError:   undefined,
            },
          };
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setDocs((d) => {
          const existing = d[docKey];
          if (!existing) return d;
          return { ...d, [docKey]: { ...existing, uploadState: 'error' as DocUploadState, uploadError: msg } };
        });
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturePaymentGeo]);

  const removeDoc = (docKey: keyof typeof docs) => {
    setDocs((d) => ({ ...d, [docKey]: null }));
    setFileError('');
    // Reset the associated geo capture when the triggering document is removed
    if (docKey === 'storeBoardPhoto') {
      setBoardPhotoGeo(null); setBoardPhotoGeoLoading(false); setBoardPhotoGeoError('');
    }
    if (docKey === 'cheque') {
      setPaymentGeo(null); setPaymentGeoLoading(false); setPaymentGeoError('');
    }
  };

  const formatBytes = (b: number) =>
    b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
  const isImage = (f: UploadedFile) => f.type.startsWith('image/');

  /** Generates a pre-filled A4 PDF self-declaration template and triggers download. */
  const downloadSelfDeclarationTemplate = async () => {
    const { jsPDF } = await import('jspdf');

    const outletCode = selectedOutlet?.outletCode ?? '___________';
    const outletName = selectedOutlet?.name       ?? '___________';

    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const PW  = 210;          // page width mm
    const M   = 20;           // left/right margin
    const CW  = PW - M * 2;  // 170 mm content width
    let y = 22;

    // ── Title ──────────────────────────────────────────────────────────────────
    doc.setFontSize(15);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(26, 26, 46);
    doc.text('SELF DECLARATION', PW / 2, y, { align: 'center' });
    y += 7;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(120, 120, 120);
    doc.text(
      'Address Proof Name Mismatch  ·  Deoleo India Trade Loyalty Programme',
      PW / 2, y, { align: 'center' },
    );
    y += 5;

    doc.setDrawColor(210, 210, 210);
    doc.line(M, y, PW - M, y);
    y += 10;

    // ── Field helper: label + optional pre-filled value + underline ────────────
    const drawField = (label: string, value: string, fx: number, fy: number, fw: number) => {
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'bold');
      doc.setTextColor(130, 130, 130);
      doc.text(label.toUpperCase(), fx, fy);

      if (value) {
        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(26, 26, 80);
        doc.text(value, fx, fy + 7.5);
      }

      doc.setDrawColor(80, 80, 80);
      doc.setTextColor(0, 0, 0);
      doc.line(fx, fy + 9, fx + fw, fy + 9);
    };

    // ── Row 1: Name | Date ─────────────────────────────────────────────────────
    const half = (CW - 10) / 2;
    drawField('Name', '',  M,             y, half);
    drawField('Date', '',  M + half + 10, y, half);
    y += 18;

    // ── Row 2: Employee ID | Outlet ID (pre-filled) ────────────────────────────
    drawField('Employee ID', '',       M,             y, half);
    drawField('Outlet ID',   outletCode, M + half + 10, y, half);
    y += 18;

    // ── Outlet Name (full width, pre-filled) ───────────────────────────────────
    drawField('Outlet Name', outletName, M, y, CW);
    y += 20;

    // ── Declaration box ────────────────────────────────────────────────────────
    const declText =
      'I hereby declare that the address proof submitted for the enrollment of outlet ' +
      outletCode + ' — ' + outletName + ' is the correct and valid address proof of the said ' +
      'outlet. The name appearing on the address proof may differ from the shop board name ' +
      'due to ownership, registration, or operational reasons. I confirm that both refer to ' +
      'the same physical premises and I take full responsibility for the accuracy and ' +
      'authenticity of the submitted document.';

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(30, 30, 30);
    const wrappedLines = doc.splitTextToSize(declText, CW - 12);
    const boxH = (wrappedLines as string[]).length * 5.5 + 10;

    doc.setFillColor(255, 252, 240);
    doc.setDrawColor(190, 170, 110);
    doc.roundedRect(M, y, CW, boxH, 3, 3, 'FD');
    doc.text(wrappedLines, M + 6, y + 7);
    y += boxH + 12;

    // ── Signature box ──────────────────────────────────────────────────────────
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(130, 130, 130);
    doc.text('SIGNATURE OF SALES REPRESENTATIVE', M, y);
    y += 4;
    doc.setDrawColor(80, 80, 80);
    doc.rect(M, y, CW, 25, 'S');

    // ── Footer ─────────────────────────────────────────────────────────────────
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(180, 180, 180);
    doc.text(
      'Fill all fields · Sign the declaration · Scan or photograph · Upload during KYC enrollment',
      PW / 2, 285, { align: 'center' },
    );

    doc.save('self-declaration-' + (selectedOutlet?.outletCode ?? 'template') + '.pdf');
  };

  /* ── C: Signature pad handlers ── */
  const getSigPos = (canvas: HTMLCanvasElement, e: React.MouseEvent | React.TouchEvent) => {
    const rect = canvas.getBoundingClientRect();
    if ('touches' in e && e.touches.length > 0) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top };
  };

  const startDraw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    setIsDrawing(true);
    setSignatureCarriedOver(false); // drawing over it makes it the rep's own signature
    const pos = getSigPos(canvas, e);
    lastPoint.current = pos;
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
  };

  const continueDraw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!isDrawing) return;
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const pos = getSigPos(canvas, e);
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';
    ctx.strokeStyle = '#1A1A2E';
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    lastPoint.current = pos;
    if (!hasSigned) setHasSigned(true);
  };

  const endDraw = () => { setIsDrawing(false); lastPoint.current = null; };

  const clearSignature = () => {
    const canvas = signatureCanvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    setHasSigned(false);
    setSignatureCarriedOver(false); // clearing it means the rep will re-sign fresh
  };

  /** Send the outlet-owner consent OTP (real MSG91 in prod; FIXED_OTP on staging). */
  const sendConsentOtp = async (subId: string | null): Promise<{ ok: boolean; error?: string }> => {
    if (!subId) return { ok: false, error: 'Could not start OTP — please retry the submission.' };
    try {
      const res = await fetch('/api/kyc/consent-otp', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ submissionId: subId, mobile: form.mobile }),
      });
      if (res.ok) return { ok: true };
      const err = await res.json().catch(() => ({}));
      return { ok: false, error: err.error ?? 'Could not send the OTP. Please try again.' };
    } catch {
      return { ok: false, error: 'Network error while sending the OTP. Please try again.' };
    }
  };

  /* ── D: Submit → OTP step ── */
  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError('');
    try {
      // Build documents payload using GCS references (fileKey/fileUrl) — never send base64
      interface DocPayload {
        type: string;
        fileKey?: string;
        fileUrl?: string;
        fileName?: string;
        mimeType?: string;
        fileSizeBytes?: number;
        // Legacy fallback only if GCS upload did not complete
        dataUrl?: string;
      }
      const buildDocPayload = (docKey: DocKey, doc: UploadedFile): DocPayload => {
        if (doc.fileKey && doc.fileUrl) {
          return {
            type:          DOC_TYPE_MAP[docKey],
            fileKey:       doc.fileKey,
            fileUrl:       doc.fileUrl,
            fileName:      doc.fileName ?? doc.name,
            mimeType:      doc.mimeType,
            fileSizeBytes: doc.fileSizeBytes,
          };
        }
        // Fallback to legacy dataUrl if upload failed/incomplete (backend still accepts it)
        return { type: DOC_TYPE_MAP[docKey], dataUrl: doc.dataUrl, fileName: doc.name };
      };

      const documents: DocPayload[] = [];
      if (docs.businessDoc)    documents.push(buildDocPayload('businessDoc',    docs.businessDoc));
      if (docs.ownerPhoto)     documents.push(buildDocPayload('ownerPhoto',     docs.ownerPhoto));
      if (docs.shopAddressDoc) documents.push(buildDocPayload('shopAddressDoc', docs.shopAddressDoc));
      if (docs.storeBoardPhoto)documents.push(buildDocPayload('storeBoardPhoto',docs.storeBoardPhoto));
      if (docs.cheque)         documents.push(buildDocPayload('cheque',         docs.cheque));
      if (docs.selfDeclaration)documents.push(buildDocPayload('selfDeclaration',docs.selfDeclaration));

      // Capture signature from canvas.
      // The pad draws near-black strokes on a TRANSPARENT canvas, so a raw export is a
      // transparent PNG that disappears on any dark background (e.g. the admin reviewer).
      // Composite the strokes over an opaque white background via an OFFSCREEN canvas so
      // the exported PNG is self-visible everywhere — without mutating the live pad
      // (drawing white onto the on-screen canvas would wipe the visible signature).
      let signatureDataUrl: string | undefined;
      if (hasSigned) {
        const src = signatureCanvasRef.current;
        if (src) {
          const flat = document.createElement('canvas');
          flat.width = src.width;
          flat.height = src.height;
          const fctx = flat.getContext('2d');
          if (fctx) {
            fctx.fillStyle = '#ffffff';
            fctx.fillRect(0, 0, flat.width, flat.height);
            fctx.drawImage(src, 0, 0);
            signatureDataUrl = flat.toDataURL('image/png');
          } else {
            signatureDataUrl = src.toDataURL('image/png');
          }
        }
      }

      const res = await fetch('/api/kyc', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          outletId:         selectedOutlet?.outletId,
          partnerName:      form.partnerName,
          mobile:           form.mobile,
          partnerClass:     form.partnerClass,
          gstNumber:        form.gstNumber,
          panNumber:        form.panNumber,
          address:          form.address,
          city:             form.city,
          state:            form.state,
          pincode:          form.pincode,
          paymentMode,
          bankName:         form.bankName,
          accountHolderName:form.accountHolderName,
          accountNumber:    form.accountNumber,
          ifscCode:         form.ifscCode,
          upiId:            form.upiId,
          boardPhotoGeo:    boardPhotoGeo ?? undefined,
          paymentGeo:       paymentGeo   ?? undefined,
          documents,
          signatureDataUrl,
          agreedToTerms,
          agreedToComms,
        }),
      });

      // A failed submission must NOT silently advance to the OTP step — surface
      // the real error (e.g. duplicate / employee phone) and stay on the form.
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        setSubmitting(false);
        setSubmitError(errorData.error ?? 'Could not submit the KYC. Please review and try again.');
        return;
      }

      const responseData = await res.json();
      const newSubmissionId = responseData.data?.submissionId ?? null;
      setSubmissionId(newSubmissionId);

      // Send the consent OTP; only advance to the OTP screen once it's actually sent.
      const sent = await sendConsentOtp(newSubmissionId);
      setSubmitting(false);
      if (!sent.ok) {
        setSubmitError(sent.error ?? 'Could not send the OTP. Please check the number and try again.');
        return;
      }
      setSubmitOtpCountdown(30);
      setStep('otp');
    } catch (e) {
      console.error('[KYC submit error]', e);
      setSubmitting(false);
      setSubmitError('Something went wrong while submitting. Please try again.');
    }
  };

  const handleVerifySubmitOtp = async () => {
    // Guard: OTP must be exactly 6 digits (submitOtp.length === 6)
    if (submitOtp.length !== 6) {
      setSubmitOtpError('Please enter a valid 6-digit OTP');
      return;
    }
    setSubmitOtpVerifying(true);
    try {
      const res = await fetch('/api/kyc/consent', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          submissionId: submissionId ?? 'unknown',
          mobile:       form.mobile,
          otp:          submitOtp,
        }),
      });

      if (res.ok) {
        setSubmitOtpError('');
        setStep('done');
      } else {
        const errorData = await res.json().catch(() => ({}));
        setSubmitOtpError(errorData.error ?? 'Incorrect OTP. Please enter the correct code.');
      }
    } catch {
      setSubmitOtpError('Network error. Please try again.');
    } finally {
      setSubmitOtpVerifying(false);
    }
  };

  const handleResendOtp = async () => {
    setSubmitOtp(''); setSubmitOtpError('');
    const sent = await sendConsentOtp(submissionId);
    if (!sent.ok) {
      setSubmitOtpError(sent.error ?? 'Could not resend the OTP. Please try again.');
      return;
    }
    setSubmitOtpCountdown(30);
  };

  /* Outlets a rep may START a NEW KYC on = those NOT yet submitted. Everything that
   * has gone into the pipeline — submitted / under review / approval-pending / Gifsy
   * review / approved / rejected / re-upload / re-KYC — is excluded from the manual
   * picker (owner 2026-06-24). Re-entry of rejected/re-KYC outlets is driven by the
   * KYC list's "Edit & Resubmit" deep-link (?outletId=), which pre-selects from the
   * full roster and bypasses this filter. */
  const STARTABLE_KYC = new Set(['NOT_STARTED', 'PENDING', 'DRAFT']);
  const isStartable = (o: AssignedOutlet) =>
    !o.rawStatus || STARTABLE_KYC.has(o.rawStatus) ||
    // A bulk / field-level re-KYC request makes even an APPROVED outlet selectable
    // (it enters locked-edit mode) — otherwise the rep couldn't correct it here. But NOT
    // while a fresh resubmission is under review (the backend blocks a duplicate submit).
    isReKycActionable(o.reKycFlags, o.rawStatus);
  const startableOutlets = assignedOutlets.filter(
    (o) => isStartable(o) && !dismissedOutlets.has(o.outletId),
  );

  /* Filtered outlets — startable, minus dismissed, matching the search text */
  const filteredOutlets = startableOutlets.filter(
    (o) =>
      o.name.toLowerCase().includes(outletSearch.toLowerCase()) ||
      o.outletCode.toLowerCase().includes(outletSearch.toLowerCase()) ||
      o.beat.toLowerCase().includes(outletSearch.toLowerCase()),
  );

  /* ── Not Interested handler ── */
  const handleConfirmNotInterested = useCallback(async () => {
    if (!confirmNotInterestedId) return;
    const outletName = assignedOutlets.find((o) => o.outletId === confirmNotInterestedId)?.name ?? confirmNotInterestedId;
    setNotInterestedLoading(true);
    try {
      await fetch('/api/kyc/not-interested', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body:    JSON.stringify({ outletId: confirmNotInterestedId }),
      });
      setDismissedOutlets((prev) => new Set([...prev, confirmNotInterestedId]));
      setNotInterestedToast(outletName);
      // If the dismissed outlet was selected, clear the selection
      if (selectedOutlet?.outletId === confirmNotInterestedId) setSelectedOutlet(null);
      setTimeout(() => setNotInterestedToast(null), 3500);
    } finally {
      setNotInterestedLoading(false);
      setConfirmNotInterestedId(null);
    }
  }, [confirmNotInterestedId, selectedOutlet]);

  /** Returns true when a doc slot is present but still uploading to GCS */
  const isDocUploading = (doc: UploadedFile | null) => doc?.uploadState === 'uploading';

  /* ── Shared styles ── */
  const inputCls = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] bg-white';
  const labelCls = 'text-xs font-medium text-gray-600 block mb-1';

  /** Extra classes for a mapped field, by its wizard key: amber when flagged for
   *  re-entry; a muted/greyed look when LOCKED (non-flagged on a field-level re-KYC). */
  const flagCls = (wizardKey: string) =>
    isReKYCFlagged(wizardKey)
      ? 'border-amber-400 bg-amber-50 focus:border-amber-500 focus:ring-amber-200/40'
      : isFieldLocked(wizardKey)
        ? 'bg-gray-50 text-gray-500 cursor-not-allowed'
        : '';

  /** Small badge shown next to a flagged field's label */
  const FlagBadge = ({ field }: { field: string }) =>
    isReKYCFlagged(field) ? (
      <span className="ml-1.5 text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full border border-amber-200 align-middle">
        Re-enter required
      </span>
    ) : isFieldLocked(field) ? (
      <span className="ml-1.5 text-[10px] font-semibold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-full border border-gray-200 align-middle">
        Locked
      </span>
    ) : null;

  /* ── FileUploadCard ── */
  const FileUploadCard = ({
    docKey, label, required, hint, inputRef,
    accept = 'image/*,application/pdf',
  }: {
    docKey: keyof typeof docs; label: string; required?: boolean;
    hint: string; inputRef: React.RefObject<HTMLInputElement | null>; accept?: string;
  }) => {
    const file = docs[docKey];
    // On a field-level re-KYC, a non-flagged doc slot is LOCKED: it stays visible /
    // pre-filled but the upload + remove/replace controls are disabled.
    const locked = isFieldLocked(docKey);
    return (
      <div>
        <label className={labelCls}>{label} {required && <span className="text-[var(--brand-primary)]">*</span>}</label>
        <input ref={inputRef} type="file" accept={accept} className="hidden" disabled={locked} onChange={(e) => handleFileSelect(docKey, e)} />
        {!file ? (
          <button type="button" disabled={locked} onClick={() => inputRef.current?.click()}
            className="w-full border-2 border-dashed border-gray-200 rounded-xl p-4 flex flex-col items-center gap-2 hover:border-[var(--brand-primary)]/40 hover:bg-green-50/30 transition-colors active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-gray-200 disabled:hover:bg-transparent disabled:active:scale-100">
            <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
              <Upload className="h-5 w-5 text-gray-400" />
            </div>
            <p className="text-xs font-medium text-gray-700">Tap to upload</p>
            <p className="text-[11px] text-gray-400">{hint}</p>
          </button>
        ) : (
          <FilePreview file={file} locked={locked} onRemove={() => removeDoc(docKey)} onReplace={() => inputRef.current?.click()} />
        )}
      </div>
    );
  };

  /* ── CameraCard ── */
  const CameraCard = ({
    docKey, label, required, hint, facing = 'environment',
  }: {
    docKey: 'ownerPhoto' | 'storeBoardPhoto'; label: string;
    required?: boolean; hint: string; facing?: 'user' | 'environment';
  }) => {
    const file = docs[docKey];
    // Non-flagged photo slot on a field-level re-KYC → locked (visible, no re-capture).
    const locked = isFieldLocked(docKey);
    return (
      <div>
        <label className={labelCls}>{label} {required && <span className="text-[var(--brand-primary)]">*</span>}</label>
        {!file ? (
          <button type="button" disabled={locked} onClick={() => openCamera(docKey, facing)}
            className="w-full border-2 border-dashed border-[var(--brand-primary)]/30 rounded-xl p-4 flex flex-col items-center gap-2 hover:border-[var(--brand-primary)]/60 hover:bg-green-50/30 transition-colors active:scale-[0.98] bg-green-50/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-[var(--brand-primary)]/30 disabled:hover:bg-green-50/10 disabled:active:scale-100">
            <div className="w-10 h-10 bg-[var(--brand-primary)]/10 rounded-full flex items-center justify-center">
              <Camera className="h-5 w-5 text-[var(--brand-primary)]" />
            </div>
            <p className="text-xs font-medium text-gray-700">Tap to open camera</p>
            <p className="text-[11px] text-gray-400">{hint}</p>
          </button>
        ) : (
          <FilePreview file={file} locked={locked} onRemove={() => removeDoc(docKey)} onReplace={() => openCamera(docKey, facing)} replaceLabel="Retake" />
        )}
      </div>
    );
  };

  /* ── FilePreview ── */
  const FilePreview = ({
    file, onRemove, onReplace, replaceLabel = 'Change', locked = false,
  }: {
    file: UploadedFile; onRemove: () => void; onReplace: () => void; replaceLabel?: string; locked?: boolean;
  }) => (
    <div className={`border rounded-xl overflow-hidden ${
      file.uploadState === 'error' ? 'border-red-300' : 'border-gray-200'
    }`}>
      {isImage(file) && (
        <div className="h-32 bg-gray-50 relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={file.dataUrl} alt={file.name} className="w-full h-full object-contain" />
          {/* Uploading overlay */}
          {file.uploadState === 'uploading' && (
            <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
              <Loader2 className="h-6 w-6 text-[var(--brand-primary)] animate-spin" />
            </div>
          )}
        </div>
      )}
      {!isImage(file) && (
        <div className={`h-16 flex items-center justify-center gap-2 ${
          file.uploadState === 'error' ? 'bg-red-50' : 'bg-green-50'
        }`}>
          {file.uploadState === 'uploading' ? (
            <Loader2 className="h-6 w-6 text-[var(--brand-primary)] animate-spin" />
          ) : (
            <FileText className={`h-6 w-6 ${file.uploadState === 'error' ? 'text-red-500' : 'text-[var(--brand-primary)]'}`} />
          )}
          <span className={`text-xs font-medium ${file.uploadState === 'error' ? 'text-red-600' : 'text-[var(--brand-primary)]'}`}>
            {file.uploadState === 'uploading' ? 'Uploading…' : 'PDF Document'}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2 bg-white">
        {isImage(file) ? <ImageIcon className="h-4 w-4 text-gray-400 shrink-0" /> : <FileText className="h-4 w-4 text-gray-400 shrink-0" />}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-800 truncate">{file.name}</p>
          {file.uploadState === 'uploading' && (
            <p className="text-[11px] text-blue-600 flex items-center gap-1">
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> Uploading to server…
            </p>
          )}
          {file.uploadState === 'uploaded' && file.carriedOver && (
            <p className="text-[11px] text-amber-600 flex items-center gap-1">
              <RefreshCw className="h-2.5 w-2.5" /> From previous submission · replace if it needs changing
            </p>
          )}
          {file.uploadState === 'uploaded' && !file.carriedOver && (
            <p className="text-[11px] text-emerald-600 flex items-center gap-1">
              <Check className="h-2.5 w-2.5" /> Uploaded · {formatBytes(file.size)}
            </p>
          )}
          {file.uploadState === 'error' && (
            <p className="text-[11px] text-red-600 flex items-center gap-1">
              <AlertCircle className="h-2.5 w-2.5 shrink-0" /> {file.uploadError ?? 'Upload failed — will use local fallback'}
            </p>
          )}
          {file.uploadState === 'idle' && (
            <p className="text-[11px] text-gray-400">{formatBytes(file.size)}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={onReplace} disabled={locked || file.uploadState === 'uploading'}
            className="text-[11px] text-[var(--brand-primary)] font-medium hover:underline disabled:opacity-40 disabled:cursor-not-allowed">{replaceLabel}</button>
          <button type="button" onClick={onRemove} disabled={locked || file.uploadState === 'uploading'}
            className="p-0.5 rounded-full hover:bg-gray-100 text-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"><X className="h-3.5 w-3.5" /></button>
        </div>
      </div>
    </div>
  );

  /* ── Step indicator ── */
  const StepBar = () => (
    <div className="flex items-center gap-1">
      {STEPS.map((s, i) => {
        const currentIdx = STEPS.indexOf(step);
        const isDone = currentIdx > i, isActive = step === s;
        return (
          <React.Fragment key={s}>
            <div className={`flex items-center gap-1 text-[11px] font-medium ${isActive ? 'text-[var(--brand-primary)]' : isDone ? 'text-emerald-600' : 'text-gray-400'}`}>
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${isActive ? 'bg-[var(--brand-primary)] text-white' : isDone ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                {isDone ? '✓' : i + 1}
              </div>
              <span className="hidden sm:inline">{STEP_LABELS[s]}</span>
            </div>
            {i < STEPS.length - 1 && <div className="flex-1 h-px bg-gray-200" />}
          </React.Fragment>
        );
      })}
    </div>
  );

  /* ── Done screen ── */
  if (step === 'done') {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-5 text-center fade-in">
        <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
          <Check className="h-8 w-8 text-emerald-600" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">
            {isReKYC ? 'Re-KYC Submitted!' : 'KYC Submitted!'}
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            {selectedOutlet?.name ?? 'The outlet'} {isReKYC ? 'has been re-submitted' : 'has been submitted'} for admin review.
            <br />You will be notified once it is approved.
            {isReKYC && <><br /><span className="text-xs text-amber-600">The outlet remains active while under review.</span></>}
          </p>
          {boardPhotoGeo && (
            <p className="text-xs text-gray-400 mt-1 flex items-center justify-center gap-1">
              <Navigation className="h-3 w-3" />
              Board photo · {boardPhotoGeo.lat.toFixed(5)}, {boardPhotoGeo.lng.toFixed(5)}
            </p>
          )}
          {paymentGeo && (
            <p className="text-xs text-gray-400 mt-0.5 flex items-center justify-center gap-1">
              <Navigation className="h-3 w-3" />
              Payment · {paymentGeo.lat.toFixed(5)}, {paymentGeo.lng.toFixed(5)}
            </p>
          )}
          {selectedOutlet && <p className="text-xs text-gray-400 mt-1">{selectedOutlet.outletCode}</p>}
        </div>
        <Button variant="primary" onClick={() => router.push('/sales/kyc')}>Back to KYC List</Button>
      </div>
    );
  }

  /* ── D: OTP verification screen (post-submit) ── */
  if (step === 'otp') {
    return (
      <div className="space-y-5 fade-in">
        <div className="flex items-center gap-3">
          <button onClick={() => setStep('bank')} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
            <ArrowLeft className="h-4 w-4 text-gray-600" />
          </button>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Verify Mobile Number</h1>
            <p className="text-xs text-gray-500">One last step — verify the outlet owner's number</p>
          </div>
        </div>

        <Card>
          <CardContent className="pt-6 space-y-5">
            {/* Illustration */}
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="w-14 h-14 bg-blue-50 rounded-full flex items-center justify-center">
                <Phone className="h-7 w-7 text-blue-500" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-gray-800">OTP sent to outlet owner</p>
                <p className="text-xs text-gray-500 mt-1">
                  A 6-digit code has been sent to{' '}
                  <span className="font-semibold text-gray-700">+91 {form.mobile}</span>
                </p>
              </div>
            </div>

            {/* OTP input */}
            <div className="space-y-3">
              <label className={labelCls}>Enter 6-digit OTP *</label>
              <div className="flex gap-2">
                <input
                  autoFocus
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-3 text-lg text-center font-mono tracking-[0.5em] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] bg-white"
                  placeholder="· · · · · ·"
                  maxLength={6}
                  value={submitOtp}
                  onChange={(e) => { setSubmitOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setSubmitOtpError(''); }}
                  inputMode="numeric"
                />
                <Button
                  variant="primary"
                  className="shrink-0 px-5"
                  loading={submitOtpVerifying}
                  disabled={submitOtp.length !== 6}
                  onClick={handleVerifySubmitOtp}
                >
                  Verify
                </Button>
              </div>

              {submitOtpError && (
                <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
                  <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
                  <p className="text-xs font-semibold text-red-700">{submitOtpError}</p>
                </div>
              )}

              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  {submitOtpCountdown > 0
                    ? `Resend OTP in ${submitOtpCountdown}s`
                    : 'Didn\'t receive the OTP?'}
                </p>
                <button
                  onClick={handleResendOtp}
                  disabled={submitOtpCountdown > 0}
                  className="text-xs font-semibold text-[var(--brand-primary)] hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Resend OTP
                </button>
              </div>
            </div>

            <p className="text-[11px] text-gray-400 text-center">
              The OTP confirms the outlet owner's consent to enroll in the Deoleo Loyalty Programme.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ── Page shell ── */
  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/sales/kyc" className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4 text-gray-600" />
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-bold text-gray-900">{isReKYC ? 'Re-KYC' : 'New KYC'}</h1>
            {isReKYC && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">
                <RefreshCw className="h-2.5 w-2.5" /> Re-KYC Required
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 truncate">
            {selectedOutlet ? selectedOutlet.name : 'Select an assigned outlet to begin'}
          </p>
        </div>
      </div>

      {/* Re-KYC banner — shown on steps 2-4 once outlet is selected */}
      {isReKYC && step !== 'outlet' && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <RefreshCw className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            {hasReKycFlags(selectedOutlet?.reKycFlags) ? (
              <>
                <p className="text-xs font-semibold text-amber-800" data-testid="rekyc-summary-banner">
                  Re-KYC requested for: {flaggedLabels(selectedOutlet?.reKycFlags).join(', ')}.
                </p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Every other field is pre-filled and locked for reference —{' '}
                  <span className="font-semibold">only the fields highlighted in amber are editable.</span>
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-semibold text-amber-800">This KYC was rejected — please review and resubmit</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  All details, documents and photos are pre-filled from the previous entry —{' '}
                  <span className="font-semibold">edit what&apos;s needed and resubmit.</span>
                </p>
              </>
            )}
            {(() => {
              const remark = reKycRemarks(selectedOutlet?.reKycFlags) || selectedOutlet?.reKycRemarks || '';
              return remark ? (
                <div className="mt-2 rounded-lg bg-amber-100/70 border border-amber-300 px-2.5 py-1.5">
                  <p className="text-[11px] font-semibold text-amber-800">Reviewer remark — fix this:</p>
                  <p className="text-xs text-amber-900 mt-0.5">{remark}</p>
                </div>
              ) : null;
            })()}
          </div>
        </div>
      )}

      <StepBar />

      {/* Global file-size error */}
      {fileError && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
          <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-red-700">File too large</p>
            <p className="text-xs text-red-600 mt-0.5">{fileError}</p>
          </div>
          <button onClick={() => setFileError('')} className="shrink-0 text-red-400 hover:text-red-600"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* ══ Step 1 — Outlet selection ══════════════════════════════════════════ */}
      {step === 'outlet' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><Building2 className="h-4 w-4" /> Select Outlet</CardTitle>
            <p className="text-xs text-gray-400 mt-1">Showing your assigned outlets — including those requiring Re-KYC.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* dropRef wraps trigger + popup + confirm dialog + toast so the
                click-outside listener doesn't close the dropdown when the
                user interacts with those overlay elements               */}
            <div ref={dropRef} className="space-y-3">
            <div className="relative">
              <label className={labelCls}>Outlet Name / ID *</label>
              <button type="button" data-testid="outlet-dropdown-trigger" onClick={() => setDropOpen((o) => !o)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border text-sm transition-all bg-white ${dropOpen ? 'border-[var(--brand-primary)] ring-2 ring-[var(--brand-primary)]/20' : 'border-gray-200 hover:border-gray-300'}`}>
                {selectedOutlet ? (
                  <div className="flex items-center gap-2 text-left flex-1 min-w-0">
                    <div className="w-7 h-7 bg-[var(--brand-primary)]/10 rounded-full flex items-center justify-center shrink-0">
                      <Building2 className="h-3.5 w-3.5 text-[var(--brand-primary)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{selectedOutlet.name}</p>
                      <p className="text-[11px] text-gray-400">{selectedOutlet.outletCode} · {TYPE_LABEL[selectedOutlet.type]}</p>
                    </div>
                  </div>
                ) : (
                  <span className="text-gray-400 flex-1 text-left">Search outlet name or ID…</span>
                )}
                <ChevronDown className={`h-4 w-4 text-gray-400 shrink-0 transition-transform duration-200 ${dropOpen ? 'rotate-180' : ''}`} />
              </button>

              {dropOpen && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white rounded-xl border border-gray-200 shadow-lg overflow-hidden">
                  <div className="p-2 border-b border-gray-100">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                      <input autoFocus type="text" value={outletSearch} onChange={(e) => setOutletSearch(e.target.value)}
                        placeholder="Type to search…"
                        className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]" />
                    </div>
                  </div>
                  <div className="max-h-60 overflow-y-auto divide-y divide-gray-50">
                    {filteredOutlets.length === 0 ? (
                      <div className="px-4 py-8 text-center text-xs text-gray-400">
                        {startableOutlets.length === 0
                          ? 'No outlets pending KYC — all your assigned outlets are already enrolled or in progress.'
                          : 'No outlets match your search'}
                      </div>
                    ) : filteredOutlets.map((o) => (
                      <div key={o.outletId} className={`flex items-center gap-2 px-3 py-2.5 transition-colors ${
                        selectedOutlet?.outletId === o.outletId
                          ? 'bg-[var(--brand-primary)]/5'
                          : o.kycStatus === 'RE_KYC_REQUIRED'
                            ? 'hover:bg-amber-50/60'
                            : 'hover:bg-gray-50'
                      }`}>
                        {/* Outlet select area */}
                        <button type="button"
                          data-testid={`outlet-option-${o.outletId}`}
                          onClick={() => { setSelectedOutlet(o); setDropOpen(false); setOutletSearch(''); }}
                          className="flex items-center gap-3 flex-1 min-w-0 text-left">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${o.kycStatus === 'RE_KYC_REQUIRED' ? 'bg-amber-100' : 'bg-gray-100'}`}>
                            {o.kycStatus === 'RE_KYC_REQUIRED'
                              ? <RefreshCw className="h-4 w-4 text-amber-600" />
                              : <Building2 className="h-4 w-4 text-gray-400" />
                            }
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className="text-sm font-medium text-gray-900 truncate">{o.name}</p>
                              {o.kycStatus === 'RE_KYC_REQUIRED' && (
                                <span className="text-[10px] font-semibold px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded-full shrink-0">Re-KYC</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-400">{o.outletCode} · {o.beat}</p>
                          </div>
                          <span className="text-[11px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full shrink-0">{TYPE_LABEL[o.type]}</span>
                          {selectedOutlet?.outletId === o.outletId && <Check className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />}
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
                    <p className="text-[11px] text-gray-400">{filteredOutlets.length} of {startableOutlets.length} outlets shown</p>
                  </div>
                </div>
              )}
            </div>
            </div>{/* /dropRef wrapper — only covers the dropdown trigger + popup */}

            <Button
              variant="primary"
              className="w-full font-bold"
              disabled={!selectedOutlet}
              onClick={() => setStep('basic')}
            >
              {selectedOutlet?.kycStatus === 'RE_KYC_REQUIRED' ? 'Begin Re-KYC →' : 'Continue →'}
            </Button>

            {/* ── Not Interested button — hidden for Re-KYC outlets ── */}
            {selectedOutlet?.kycStatus !== 'RE_KYC_REQUIRED' && (
              <button
                type="button"
                data-testid="ni-btn"
                disabled={!selectedOutlet}
                onClick={() => setConfirmNotInterestedId(selectedOutlet!.outletId)}
                className="w-full text-sm font-normal py-2 px-4 rounded-lg bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Not Interested
              </button>
            )}

            {/* ── Not Interested success toast ── */}
            {notInterestedToast && (
              <div data-testid="not-interested-toast"
                className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-600 shrink-0" />
                <p className="text-xs font-medium text-emerald-700">
                  <span className="font-semibold">{notInterestedToast}</span> marked as Not Interested.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Not Interested confirmation modal — rendered outside the card ── */}
      {confirmNotInterestedId && (() => {
        const outlet = assignedOutlets.find((o) => o.outletId === confirmNotInterestedId);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/40" onClick={() => setConfirmNotInterestedId(null)} />
            {/* Dialog */}
            <div data-testid="not-interested-confirm-dialog"
              className="relative w-full max-w-sm bg-white rounded-2xl shadow-xl p-5 space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
                  <AlertCircle className="h-5 w-5 text-gray-600" />
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900">Mark as Not Interested?</p>
                  <p className="text-xs text-gray-500 mt-1">
                    <span className="font-semibold text-gray-700">{outlet?.name}</span> will be removed from your pending KYC list.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setConfirmNotInterestedId(null)}
                  className="flex-1 text-sm font-semibold py-2 px-4 rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
                <button type="button" onClick={handleConfirmNotInterested} disabled={notInterestedLoading}
                  className="flex-1 text-sm font-semibold py-2 px-4 rounded-xl bg-gray-700 text-white hover:bg-gray-800 disabled:opacity-60 transition-colors">
                  {notInterestedLoading ? 'Saving…' : 'Yes, Not Interested'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ══ Step 2 — Basic details (phone collected, NO inline OTP) ════════════ */}
      {step === 'basic' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><User className="h-4 w-4" /> Partner Information</CardTitle>
            {/* Outlet + Programme info — 2 chips side by side to reduce form length */}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200 min-w-0">
                <Building2 className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-gray-700 truncate">{selectedOutlet?.name}</p>
                  <p className="text-[11px] text-gray-400 truncate">{selectedOutlet?.outletCode} · {TYPE_LABEL[selectedOutlet?.type ?? 'SSS']}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--brand-primary)]/5 rounded-lg border border-[var(--brand-primary)]/20 min-w-0">
                <ShieldCheck className="h-3.5 w-3.5 text-[var(--brand-primary)] shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[var(--brand-primary)] truncate">{selectedOutlet?.programName || 'Programme'}</p>
                  <p className="text-[11px] text-[var(--brand-primary)]/70 truncate">{selectedOutlet?.programCategory || '—'}</p>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Owner name */}
            <div>
              <label className={labelCls}>Owner / Contact Name *<FlagBadge field="partnerName" /></label>
              <input className={`${inputCls} ${flagCls('partnerName')}`} placeholder="Full name" value={form.partnerName} onChange={set('partnerName')}
                disabled={isFieldLocked('partnerName')} readOnly={isFieldLocked('partnerName')} />
            </div>

            {/* Mobile — conflict check only, OTP happens after final submit */}
            <div>
              <label className={labelCls}>Mobile Number *<FlagBadge field="mobile" /></label>
              <div className="flex gap-2">
                <span className="px-3 py-2.5 bg-gray-50 border border-r-0 border-gray-200 rounded-l-xl text-sm text-gray-500 shrink-0">+91</span>
                <input
                  className={`${inputCls} rounded-l-none flex-1 ${flagCls('mobile')} ${
                    mobileCheck === 'ok' ? 'bg-emerald-50 border-emerald-200' :
                    mobileCheck === 'outlet_conflict' || mobileCheck === 'employee_conflict' ? 'border-red-400 bg-red-50 focus:border-red-400 focus:ring-red-200/40' : ''
                  }`}
                  placeholder="9876543210" maxLength={10} value={form.mobile}
                  onChange={handleMobileChange} inputMode="numeric"
                  disabled={isFieldLocked('mobile')}
                  readOnly={isFieldLocked('mobile') || mobileCheck === 'outlet_conflict' || mobileCheck === 'employee_conflict'}
                />
                {mobileCheck === 'checking' && (
                  <div className="flex items-center px-3 shrink-0 text-gray-400">
                    <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                  </div>
                )}
                {mobileCheck === 'ok' && (
                  <div className="flex items-center px-2 shrink-0" title="Number available">
                    <Check className="h-5 w-5 text-emerald-500" />
                  </div>
                )}
                {(mobileCheck === 'outlet_conflict' || mobileCheck === 'employee_conflict') && (
                  <Button variant="outline" size="sm" className="shrink-0 text-xs text-gray-500"
                    onClick={() => { setMobileCheck('idle'); setMobileCheckMsg(''); setForm(f => ({ ...f, mobile: '' })); }}>
                    Clear
                  </Button>
                )}
              </div>

              {mobileCheck === 'outlet_conflict' && (
                <div className="mt-2 flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
                  <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-red-700">Number already in use</p>
                    <p className="text-xs text-red-600 mt-0.5">{mobileCheckMsg}</p>
                  </div>
                </div>
              )}
              {mobileCheck === 'employee_conflict' && (
                <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
                  <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-amber-700">Employee number not allowed</p>
                    <p className="text-xs text-amber-600 mt-0.5">{mobileCheckMsg}</p>
                  </div>
                </div>
              )}
              {mobileCheck === 'ok' && (
                <p className="mt-1 text-[11px] text-emerald-600 flex items-center gap-1">
                  <ShieldCheck className="h-3 w-3" /> Number available — OTP will be sent for verification after final submit.
                </p>
              )}
            </div>

            {/* GST (optional — blank never errors; a non-empty value is validated against the 15-char GSTIN format) */}
            <div>
              <label className={labelCls}>GST Number<FlagBadge field="gstNumber" /></label>
              <input
                className={`${inputCls} ${flagCls('gstNumber')} ${
                  form.gstNumber.length === 0
                    ? ''
                    : isValidGstin(form.gstNumber)
                      ? 'border-emerald-300 bg-emerald-50/40 focus:border-emerald-400 focus:ring-emerald-200/40'
                      : form.gstNumber.length === GSTIN_LENGTH
                        ? 'border-red-300 bg-red-50/40 focus:border-red-400 focus:ring-red-200/40'
                        : ''
                }`}
                placeholder="27AAPFU0939F1Z5"
                maxLength={GSTIN_LENGTH}
                value={form.gstNumber}
                onChange={handleGSTChange}
                disabled={isFieldLocked('gstNumber')}
                readOnly={isFieldLocked('gstNumber')}
              />
              {form.gstNumber.length > 0 && form.gstNumber.length < GSTIN_LENGTH && (
                <p className="text-[11px] text-amber-600 mt-1 flex items-center gap-1"><AlertCircle className="h-3 w-3" /> {GSTIN_LENGTH - form.gstNumber.length} more characters needed</p>
              )}
              {form.gstNumber.length === GSTIN_LENGTH && !isValidGstin(form.gstNumber) && (
                <p className="text-[11px] text-red-600 mt-1 flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Invalid GST number format</p>
              )}
              {isValidGstin(form.gstNumber) && (
                <p className="text-[11px] text-emerald-600 mt-1 flex items-center gap-1"><Check className="h-3 w-3" /> Valid GST number</p>
              )}
            </div>

            {/* PAN */}
            <div>
              <label className={labelCls}>
                PAN Number
                {form.gstNumber.length >= 12 && <span className="ml-1.5 text-[11px] text-emerald-600 font-normal">● Auto-filled from GST</span>}
                <FlagBadge field="panNumber" />
              </label>
              <input className={`${inputCls} ${form.gstNumber.length >= 12 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : ''} ${flagCls('panNumber')}`}
                placeholder="AAPFU0939F" value={form.panNumber} onChange={set('panNumber')}
                disabled={isFieldLocked('panNumber')}
                readOnly={isFieldLocked('panNumber') || form.gstNumber.length >= 12} />
            </div>

            {/* KYC Documents */}
            <div className="pt-1 space-y-4">
              <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 text-[var(--brand-primary)]" /> KYC Documents
              </p>
              {/* Wrap flagged docs in an amber outline */}
              <div className={isReKYCFlagged('businessDoc') ? 'rounded-xl border border-amber-300 p-2 bg-amber-50/40' : ''}>
                {isReKYCFlagged('businessDoc') && (
                  <p className="text-[10px] font-semibold text-amber-700 mb-1.5 flex items-center gap-1">
                    <RefreshCw className="h-2.5 w-2.5" /> Re-upload required
                  </p>
                )}
                <FileUploadCard docKey="businessDoc" label="GST Certificate" required
                  hint="PDF or image · Max 5 MB · Auto-compressed" inputRef={businessDocRef} />
              </div>
              <div className={isReKYCFlagged('ownerPhoto') ? 'rounded-xl border border-amber-300 p-2 bg-amber-50/40' : ''}>
                {isReKYCFlagged('ownerPhoto') && (
                  <p className="text-[10px] font-semibold text-amber-700 mb-1.5 flex items-center gap-1">
                    <RefreshCw className="h-2.5 w-2.5" /> Re-capture required
                  </p>
                )}
                <CameraCard docKey="ownerPhoto" label="Owner Photo" required
                  hint="Front-facing camera · Auto-compressed to JPEG" facing="user" />
              </div>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setStep('outlet')}>← Back</Button>
              <Button variant="primary" className="flex-1" onClick={() => setStep('address')}
                disabled={
                  !form.partnerName ||
                  form.mobile.length !== 10 ||
                  mobileCheck === 'outlet_conflict' ||
                  mobileCheck === 'employee_conflict' ||
                  mobileCheck === 'idle' ||
                  mobileCheck === 'checking' ||
                  !docs.businessDoc ||
                  !docs.ownerPhoto ||
                  isDocUploading(docs.businessDoc) ||
                  isDocUploading(docs.ownerPhoto)
                }>
                Continue →
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ══ Step 3 — Address ════════════════════════════════════════════════════ */}
      {step === 'address' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><MapPin className="h-4 w-4" /> Shop Address</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">

            <div>
              <label className={labelCls}>Street Address *<FlagBadge field="address" /></label>
              <input className={`${inputCls} ${flagCls('address')}`} placeholder="Shop no., street name" value={form.address} onChange={set('address')}
                disabled={isFieldLocked('address')} readOnly={isFieldLocked('address')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>City *<FlagBadge field="city" /></label>
                <input className={`${inputCls} ${flagCls('city')}`} placeholder="City" value={form.city} onChange={set('city')}
                  disabled={isFieldLocked('city')} readOnly={isFieldLocked('city')} />
              </div>
              <div>
                <label className={labelCls}>Pincode *<FlagBadge field="pincode" /></label>
                <input className={`${inputCls} ${flagCls('pincode')}`} placeholder="400001" maxLength={6} value={form.pincode} onChange={set('pincode')} inputMode="numeric"
                  disabled={isFieldLocked('pincode')} readOnly={isFieldLocked('pincode')} />
              </div>
            </div>
            <div>
              <label className={labelCls}>State *<FlagBadge field="state" /></label>
              <SearchableSelect
                options={INDIAN_STATES}
                value={form.state}
                onChange={(v) => setForm((f) => ({ ...f, state: v }))}
                placeholder="Maharashtra"
                className={`${inputCls} ${flagCls('state')}`}
                disabled={isFieldLocked('state')}
                testIdPrefix="state-select"
                aria-label="State"
              />
            </div>

            <div className="pt-1 space-y-4">
              <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 text-[var(--brand-primary)]" /> Store Address &amp; Store Documents
              </p>

              {/* Address Proof upload */}
              <FileUploadCard docKey="shopAddressDoc" label="Address Proof" required
                hint="Accepted: GST certificate, electricity bill, telephone bill, rent agreement, Aadhaar card (if sole proprietor) · PDF or image · Max 5 MB"
                inputRef={shopAddressDocRef} />

              {/* ── Name mismatch checkbox ── */}
              <label className="flex items-start gap-3 cursor-pointer group">
                <div
                  className={`mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                    nameMismatch
                      ? 'bg-amber-500 border-amber-500'
                      : 'border-gray-300 group-hover:border-amber-400'
                  }`}
                  onClick={() => {
                    const next = !nameMismatch;
                    setNameMismatch(next);
                    if (!next) removeDoc('selfDeclaration');
                  }}
                >
                  {nameMismatch && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                </div>
                <span className="text-sm text-gray-700 leading-snug">
                  Shop board name and address proof name do not match
                </span>
              </label>

              {/* ── Self Declaration — shown only when mismatch is flagged ── */}
              {nameMismatch && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-3">
                  {/* Info banner */}
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-semibold text-amber-700">Self Declaration Required</p>
                      <p className="text-[11px] text-amber-600 mt-0.5 leading-relaxed">
                        Download the template, fill in your details, sign it, and upload the completed document below.
                      </p>
                    </div>
                  </div>

                  {/* Template download link */}
                  <button
                    type="button"
                    onClick={downloadSelfDeclarationTemplate}
                    className="flex items-center gap-1.5 text-xs font-semibold text-[var(--brand-primary)] hover:underline active:opacity-70 transition-opacity"
                  >
                    <FileDown className="h-3.5 w-3.5" />
                    Download Self Declaration Template
                  </button>

                  {/* Upload for signed declaration */}
                  <input
                    ref={selfDeclarationRef}
                    type="file"
                    accept="image/*,application/pdf"
                    className="hidden"
                    onChange={(e) => handleFileSelect('selfDeclaration', e)}
                  />
                  <FileUploadCard
                    docKey="selfDeclaration"
                    label="Self Declaration (signed)"
                    required
                    hint="Upload the completed &amp; signed declaration · PDF or image · Max 5 MB"
                    inputRef={selfDeclarationRef}
                  />
                </div>
              )}

              {/* Store Board Photo */}
              <CameraCard docKey="storeBoardPhoto" label="Store Board Photo" required
                hint="Rear camera · Capture the shop signboard clearly · Location is captured automatically"
                facing="environment" />

              {/* Board photo geo status — shown after photo is taken */}
              {docs.storeBoardPhoto && (
                <div className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-xs ${
                  boardPhotoGeo
                    ? 'bg-emerald-50 border-emerald-200'
                    : boardPhotoGeoError
                    ? 'bg-red-50 border-red-200'
                    : 'bg-blue-50 border-blue-200'
                }`}>
                  {boardPhotoGeoLoading && <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />}
                  {boardPhotoGeo        && <Navigation className="h-4 w-4 text-emerald-600 shrink-0" />}
                  {boardPhotoGeoError   && <AlertCircle data-testid="board-photo-geo-error" className="h-4 w-4 text-red-500 shrink-0" />}
                  {!boardPhotoGeoLoading && !boardPhotoGeo && !boardPhotoGeoError && <Navigation className="h-4 w-4 text-blue-500 shrink-0" />}
                  <div className="flex-1 min-w-0">
                    {boardPhotoGeoLoading && <p className="text-blue-700 font-medium">Capturing location…</p>}
                    {boardPhotoGeo        && <p className="text-emerald-700 font-medium">Location captured · {boardPhotoGeo.lat.toFixed(5)}, {boardPhotoGeo.lng.toFixed(5)} <span className="font-normal text-emerald-500">(±{boardPhotoGeo.accuracy}m)</span></p>}
                    {boardPhotoGeoError   && (
                      <div>
                        <p data-testid="board-photo-geo-error" className="text-red-700 font-medium">Location required</p>
                        <p className="text-red-600 mt-0.5">{boardPhotoGeoError}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setStep('basic')}>← Back</Button>
              <Button variant="primary" className="flex-1" onClick={() => setStep('bank')}
                disabled={
                  !form.address || !form.city || !form.pincode ||
                  !docs.shopAddressDoc || !docs.storeBoardPhoto ||
                  (nameMismatch && !docs.selfDeclaration) ||
                  boardPhotoGeoLoading ||
                  !boardPhotoGeo ||
                  isDocUploading(docs.shopAddressDoc) ||
                  isDocUploading(docs.storeBoardPhoto) ||
                  isDocUploading(docs.selfDeclaration)
                }>
                Continue →
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ══ Camera capture modal ══════════════════════════════════════════════ */}
      {cameraDocKey && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 bg-black/60 shrink-0">
            <button onClick={closeCamera} className="p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"><X className="h-5 w-5" /></button>
            <p className="text-sm font-semibold text-white">{cameraDocKey === 'ownerPhoto' ? 'Owner Photo' : 'Store Board Photo'}</p>
            <button onClick={flipCamera} className="p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"><RefreshCw className="h-5 w-5" /></button>
          </div>
          <div className="flex-1 relative overflow-hidden bg-black flex items-center justify-center">
            {cameraErr ? (
              <div className="flex flex-col items-center gap-3 px-8 text-center">
                <AlertCircle className="h-10 w-10 text-red-400" />
                <p className="text-sm text-white font-semibold">Camera unavailable</p>
                <p className="text-xs text-gray-400 leading-relaxed">{cameraErr}</p>
                <button onClick={closeCamera} className="mt-2 px-4 py-2 bg-white/10 text-white text-sm rounded-xl hover:bg-white/20 transition-colors">Close</button>
              </div>
            ) : (
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover"
                style={cameraFacing === 'user' ? { transform: 'scaleX(-1)' } : undefined} />
            )}
            {!cameraErr && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-3/4 aspect-[4/3] relative">
                  {(['tl','tr','bl','br'] as const).map((c) => (
                    <div key={c} className={`absolute w-8 h-8 border-white border-[3px] rounded-sm ${
                      c === 'tl' ? 'top-0 left-0 border-r-0 border-b-0' :
                      c === 'tr' ? 'top-0 right-0 border-l-0 border-b-0' :
                      c === 'bl' ? 'bottom-0 left-0 border-r-0 border-t-0' :
                                   'bottom-0 right-0 border-l-0 border-t-0'
                    }`} />
                  ))}
                </div>
              </div>
            )}
          </div>
          {!cameraErr && (
            <div className="shrink-0 flex items-center justify-center px-4 py-6 bg-black/60">
              <button onClick={capturePhoto} disabled={capturing}
                className="w-16 h-16 rounded-full bg-white flex items-center justify-center shadow-lg active:scale-95 transition-transform disabled:opacity-50">
                <div className="w-12 h-12 rounded-full border-2 border-gray-300 bg-white flex items-center justify-center">
                  {capturing ? <Loader2 className="h-5 w-5 text-gray-500 animate-spin" /> : <Camera className="h-6 w-6 text-gray-700" />}
                </div>
              </button>
            </div>
          )}
        </div>
      )}

      {/* ══ Step 4 — Bank + Checkboxes + Signature ════════════════════════════ */}
      {step === 'bank' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm"><CreditCard className="h-4 w-4" /> Bank Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Re-KYC bank flag notice */}
            {(isReKYCFlagged('bankName') || isReKYCFlagged('accountHolderName') || isReKYCFlagged('accountNumber') || isReKYCFlagged('ifscCode') || isReKYCFlagged('upiId') || isReKYCFlagged('cheque')) && (
              <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-700">
                <RefreshCw className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>Bank details have been flagged for re-entry. Please re-fill the highlighted fields and re-upload the cancelled cheque.</span>
              </div>
            )}

            {/* Bank / UPI toggle section */}
            <BankOrUpiSection
              paymentMode={paymentMode}
              onPaymentModeChange={setPaymentMode}
              bankName={form.bankName}
              accountHolderName={form.accountHolderName}
              accountNumber={form.accountNumber}
              ifscCode={form.ifscCode}
              onFieldChange={(field) => set(field as keyof typeof form)}
              disabledFields={{
                bankName:          isFieldLocked('bankName'),
                accountHolderName: isFieldLocked('accountHolderName'),
                accountNumber:     isFieldLocked('accountNumber'),
                ifscCode:          isFieldLocked('ifscCode'),
                upiId:             isFieldLocked('upiId'),
              }}
              upiId={form.upiId}
              onUpiChange={(val) => {
                setForm((f) => ({ ...f, upiId: val }));
                // Clearing a scanned UPI resets the payment geo (user must re-scan)
                if (!val) {
                  setPaymentGeo(null); setPaymentGeoLoading(false); setPaymentGeoError('');
                }
              }}
              onPaymentGeoTrigger={capturePaymentGeo}
            >
              {/* Cheque upload — shown inside bank mode */}
              <div className={isReKYCFlagged('cheque') ? 'rounded-xl border border-amber-300 p-2 bg-amber-50/40' : ''}>
                {isReKYCFlagged('cheque') && (
                  <p className="text-[10px] font-semibold text-amber-700 mb-1.5 flex items-center gap-1">
                    <RefreshCw className="h-2.5 w-2.5" /> Re-upload required
                  </p>
                )}
                <FileUploadCard docKey="cheque" label="Cancelled Cheque" required
                  hint="Upload a cancelled cheque leaf · PDF or image · Max 5 MB · Auto-compressed"
                  inputRef={chequeRef} />
              </div>
              <p className="text-xs text-gray-400 -mt-1">Used to verify bank account details before payout.</p>
            </BankOrUpiSection>

            {/* Payment geo status — shown after cheque upload or QR scan */}
            {(docs.cheque || form.upiId) && (
              <div className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-xs ${
                paymentGeo
                  ? 'bg-emerald-50 border-emerald-200'
                  : paymentGeoError
                  ? 'bg-red-50 border-red-200'
                  : 'bg-blue-50 border-blue-200'
              }`}>
                {paymentGeoLoading && <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />}
                {paymentGeo        && <Navigation className="h-4 w-4 text-emerald-600 shrink-0" />}
                {paymentGeoError   && <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />}
                {!paymentGeoLoading && !paymentGeo && !paymentGeoError && <Navigation className="h-4 w-4 text-blue-500 shrink-0" />}
                <div data-testid="payment-geo-tag" className="flex-1 min-w-0">
                  {paymentGeoLoading && <p className="text-blue-700 font-medium">Capturing payment location…</p>}
                  {paymentGeo        && <p className="text-emerald-700 font-medium">Location captured · {paymentGeo.lat.toFixed(5)}, {paymentGeo.lng.toFixed(5)} <span className="font-normal text-emerald-500">(±{paymentGeo.accuracy}m)</span></p>}
                  {paymentGeoError   && (
                    <div>
                      <p data-testid="payment-geo-error" className="text-red-700 font-medium">Location required</p>
                      <p className="text-red-600 mt-0.5">{paymentGeoError}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── B: Consent checkboxes ── */}
            <div className="border-t border-gray-100 pt-4 space-y-3">
              <p className="text-xs font-semibold text-gray-700">Programme Consent</p>

              <label className="flex items-start gap-3 cursor-pointer group">
                <div className={`mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                  agreedToTerms ? 'bg-[var(--brand-primary)] border-[var(--brand-primary)]' : 'border-gray-300 group-hover:border-[var(--brand-primary)]/60'
                }`}
                  onClick={() => setAgreedToTerms((v) => !v)}>
                  {agreedToTerms && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                </div>
                <span className="text-sm text-gray-700 leading-snug">
                  I agree to the{' '}
                  <button type="button" className="text-[var(--brand-primary)] font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>
                    Terms and Conditions of the Programme
                  </button>
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer group">
                <div className={`mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                  agreedToComms ? 'bg-[var(--brand-primary)] border-[var(--brand-primary)]' : 'border-gray-300 group-hover:border-[var(--brand-primary)]/60'
                }`}
                  onClick={() => setAgreedToComms((v) => !v)}>
                  {agreedToComms && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                </div>
                <span className="text-sm text-gray-700 leading-snug">
                  I agree to receive programme communications over{' '}
                  <span className="font-semibold">SMS and WhatsApp</span>
                </span>
              </label>
            </div>

            {/* ── C: Digital Signature ── */}
            <div className="border-t border-gray-100 pt-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                  <PenLine className="h-3.5 w-3.5 text-[var(--brand-primary)]" /> Add Digital Signature
                </p>
                {hasSigned && (
                  <button type="button" onClick={clearSignature}
                    className="text-[11px] font-semibold text-red-500 hover:text-red-700 flex items-center gap-1 transition-colors">
                    <X className="h-3 w-3" /> Clear
                  </button>
                )}
              </div>
              <p className="text-[11px] text-gray-400">Owner signs below to confirm KYC consent</p>
              {signatureCarriedOver && (
                <p className="text-[11px] text-amber-600 flex items-center gap-1">
                  <RefreshCw className="h-3 w-3 shrink-0" /> Signature carried over from the previous submission — Clear to re-sign.
                </p>
              )}

              <div className={`relative rounded-xl border-2 overflow-hidden transition-colors ${
                hasSigned ? 'border-[var(--brand-primary)]/40' : 'border-dashed border-gray-300'
              }`}>
                {!hasSigned && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <p className="text-sm text-gray-300 font-medium select-none">Sign here</p>
                  </div>
                )}
                <canvas
                  ref={signatureCanvasRef}
                  width={600}
                  height={120}
                  className="w-full touch-none bg-white cursor-crosshair"
                  style={{ height: '120px' }}
                  onMouseDown={startDraw}
                  onMouseMove={continueDraw}
                  onMouseUp={endDraw}
                  onMouseLeave={endDraw}
                  onTouchStart={startDraw}
                  onTouchMove={continueDraw}
                  onTouchEnd={endDraw}
                />
              </div>
              {!hasSigned && (
                <p className="text-[11px] text-amber-600 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 shrink-0" /> Signature required to proceed.
                </p>
              )}
            </div>

            {/* Submit/OTP-send error (e.g. duplicate or employee phone) */}
            {submitError && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
                <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-red-700">Could not submit</p>
                  <p className="text-xs text-red-600 mt-0.5">{submitError}</p>
                </div>
                <button onClick={() => setSubmitError('')} className="shrink-0 text-red-400 hover:text-red-600"><X className="h-3.5 w-3.5" /></button>
              </div>
            )}

            {/* Submit */}
            <div className="flex gap-3 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setStep('address')}>← Back</Button>
              <Button variant="primary" className="flex-1" loading={submitting} onClick={handleSubmit}
                disabled={
                  (paymentMode === 'bank'
                    ? (!form.bankName || !form.accountNumber || !form.ifscCode || !docs.cheque)
                    : (!form.upiId || !isValidUpiId(form.upiId))
                  ) || !agreedToTerms || !agreedToComms || !hasSigned ||
                  paymentGeoLoading ||
                  !paymentGeo ||
                  isDocUploading(docs.cheque)
                }>
                Submit KYC
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
