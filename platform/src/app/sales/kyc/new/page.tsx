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
import { isValidUpiId } from '@/lib/upi-utils';
import type { GeoCapture } from '@/types';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

type Step = 'outlet' | 'basic' | 'address' | 'bank' | 'otp' | 'done';

interface AssignedOutlet {
  outletId: string;
  name: string;
  beat: string;
  type: 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';
  /** Present only for outlets flagged for Re-KYC */
  kycStatus?:    'APPROVED' | 'RE_KYC_REQUIRED';
  /** Fields that must be re-captured; keys match form field names */
  reKycFlags?:   Partial<Record<string, boolean>>;
  /** Existing KYC data — pre-fills the form for Re-KYC outlets */
  existingKyc?:  {
    partnerName: string; mobile: string; gstNumber: string; panNumber: string;
    address: string; city: string; state: string; pincode: string;
    bankName: string; accountNumber: string; ifscCode: string; upiId: string;
  };
  reKycRemarks?: string;
}

interface UploadedFile {
  name: string;
  size: number;
  type: string;
  dataUrl: string;
}

/* ─── Constants ──────────────────────────────────────────────────────────────── */

const MAX_FILE_BYTES    = 5 * 1024 * 1024;
const COMPRESS_QUALITY  = 0.82;
const COMPRESS_MAX_DIM  = 1920;

/* ─── Mock data ──────────────────────────────────────────────────────────────── */

const ASSIGNED_OUTLETS: AssignedOutlet[] = [
  { outletId: 'OUT-2026-001', name: 'Verma Traders',         beat: 'Andheri Beat', type: 'SSS'     },
  { outletId: 'OUT-2026-002', name: 'Joshi Provisions',      beat: 'Andheri Beat', type: 'SSS'     },
  { outletId: 'OUT-2026-003', name: 'Nair General Store',    beat: 'Andheri Beat', type: 'WHOLESALER'   },
  { outletId: 'OUT-2026-004', name: 'Gupta Kirana',          beat: 'Andheri Beat', type: 'SSS'     },
  { outletId: 'OUT-2026-005', name: 'Agarwal Mart',          beat: 'Kandivali',    type: 'SUB_STOCKIST' },
  { outletId: 'OUT-2026-006', name: 'Rao Superstore',        beat: 'Kandivali',    type: 'WHOLESALER'   },
  { outletId: 'OUT-2026-007', name: 'Mishra Brothers',       beat: 'Borivali',     type: 'SSS'     },
  { outletId: 'OUT-2026-008', name: 'Shetty Provision Mart', beat: 'Borivali',     type: 'SSS'     },
  // Re-KYC outlet — admin flagged specific fields for re-capture
  {
    outletId:  'OUT-2026-K11',
    name:      'Krishnamurthy & Sons',
    beat:      'Koramangala Beat',
    type:      'WHOLESALER',
    kycStatus: 'RE_KYC_REQUIRED',
    reKycRemarks: 'GST certificate expired. PAN number update requested by compliance team.',
    reKycFlags: {
      gstNumber:    true,
      panNumber:    true,
      businessDoc:  true,   // GST Certificate re-upload
      accountNumber: true,  // bank detail correction
    },
    existingKyc: {
      partnerName:   'K. Krishnamurthy',
      mobile:        '9444181920',
      gstNumber:     '',   // blanked — must be re-entered
      panNumber:     '',   // blanked — must be re-entered
      address:       '14, 2nd Main, Koramangala 4th Block',
      city:          'Bengaluru',
      state:         'Karnataka',
      pincode:       '560034',
      bankName:      'HDFC Bank',
      accountNumber: '',   // blanked — must be re-entered
      ifscCode:      'HDFC0001234',
      upiId:         '',
    },
  },
];

const TYPE_LABEL: Record<AssignedOutlet['type'], string> = {
  SSS: 'SSS', WHOLESALER: 'Wholesaler', SUB_STOCKIST: 'Sub-Stockist',
};

const REGISTERED_OUTLET_PHONES: Record<string, { name: string; outletId: string }> = {
  '9876543210': { name: 'Kumar General Store',  outletId: 'OUT-2026-K01' },
  '9765432109': { name: 'Sharma Kirana',        outletId: 'OUT-2026-K02' },
  '9654321098': { name: 'Patel Grocery',        outletId: 'OUT-2026-K03' },
  '9543210987': { name: 'Singh Supermart',      outletId: 'OUT-2026-K04' },
  '9432109876': { name: 'Mehta Provisions',     outletId: 'OUT-2026-K05' },
  '9321098765': { name: 'Desai Grocers',        outletId: 'OUT-2026-K06' },
  '9820184321': { name: 'Sharma General Store', outletId: 'OUT-2026-K10' },
  '9444181920': { name: 'Krishnamurthy & Sons', outletId: 'OUT-2026-K11' },
};

const EMPLOYEE_PHONES: Record<string, string> = {
  '9800000001': 'Anil Sharma (ISR)',   '9800000002': 'Rajesh Kumar (SO)',
  '9800000003': 'Priya Mehta (ASM)',   '9800000004': 'Suresh Nair (State Head)',
  '9800000005': 'Vikram Singh (HO)',   '9800000006': 'Ravi Pillai (ISR)',
  '9800000007': 'Deepa Nair (ISR)',    '9800000008': 'Kiran Joshi (ISR)',
  '9800000009': 'Sanjay Kumar (ISR)',  '9700000001': 'Anita Rao (ISR)',
  '9700000002': 'Manoj Desai (ISR)',
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
  const [docs, setDocs] = useState<{
    businessDoc:      UploadedFile | null;
    ownerPhoto:       UploadedFile | null;
    shopAddressDoc:   UploadedFile | null;
    storeBoardPhoto:  UploadedFile | null;
    cheque:           UploadedFile | null;
    selfDeclaration:  UploadedFile | null;
  }>({ businessDoc: null, ownerPhoto: null, shopAddressDoc: null, storeBoardPhoto: null, cheque: null, selfDeclaration: null });

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

  /* D — Post-submit OTP */
  const [submitOtp,          setSubmitOtp]          = useState('');
  const [submitOtpError,     setSubmitOtpError]     = useState('');
  const [submitOtpVerifying, setSubmitOtpVerifying] = useState(false);
  const [submitOtpCountdown, setSubmitOtpCountdown] = useState(0);

  /* File error */
  const [fileError, setFileError] = useState('');

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

  /* Derived: is this a Re-KYC flow? */
  const isReKYC = selectedOutlet?.kycStatus === 'RE_KYC_REQUIRED';

  /** Returns true when a form field or doc key is flagged for re-capture */
  const isReKYCFlagged = (key: string) => !!(isReKYC && selectedOutlet?.reKycFlags?.[key]);

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
      accountNumber: k.accountNumber,
      ifscCode:      k.ifscCode,
      upiId:         k.upiId,
    }));
    // Trigger mobile-conflict check for the pre-filled number
    if (k.mobile.length === 10) setMobileCheck('ok');
  }, [selectedOutlet]);

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
    const gst = e.target.value.toUpperCase().slice(0, 12);
    setForm((f) => ({ ...f, gstNumber: gst, panNumber: gst.length === 12 ? gst.substring(2, 12) : f.panNumber }));
  };

  /** Auto-run conflict check when 10 digits entered. No OTP here. */
  const handleMobileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 10);
    setForm((f) => ({ ...f, mobile: val }));
    setMobileCheck('idle'); setMobileCheckMsg('');

    if (val.length === 10) {
      setMobileCheck('checking');
      await new Promise((r) => setTimeout(r, 400));
      const existingOutlet = REGISTERED_OUTLET_PHONES[val];
      if (existingOutlet) {
        setMobileCheck('outlet_conflict');
        setMobileCheckMsg(`Already registered to ${existingOutlet.name} (${existingOutlet.outletId}). Each outlet must have a unique contact number.`);
        return;
      }
      const employee = EMPLOYEE_PHONES[val];
      if (employee) {
        setMobileCheck('employee_conflict');
        setMobileCheckMsg(`This number belongs to employee ${employee} and cannot be used for an outlet KYC.`);
        return;
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
    setDocs((d) => ({ ...d, [key]: { name: `${key}_${Date.now()}.jpg`, size, type: 'image/jpeg', dataUrl } }));
    setCapturing(false);
    closeCamera();
    // Trigger geo capture #1 immediately after the board photo is taken
    if (key === 'storeBoardPhoto') {
      captureBoardPhotoGeo();
    }
  };

  /* ── File select ── */
  const handleFileSelect = useCallback(async (docKey: keyof typeof docs, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setFileError('');
    if (file.size > MAX_FILE_BYTES) { setFileError(`"${file.name}" is ${formatBytes(file.size)} — max 5 MB.`); return; }
    const result = await compressFile(file);
    if (!result) return;
    setDocs((d) => ({ ...d, [docKey]: { name: file.name, size: result.size, type: result.type, dataUrl: result.dataUrl } }));
    // Trigger geo capture #2 when the cancelled cheque is uploaded
    if (docKey === 'cheque') {
      capturePaymentGeo();
    }
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

    const outletId   = selectedOutlet?.outletId ?? '___________';
    const outletName = selectedOutlet?.name     ?? '___________';

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
    drawField('Outlet ID',   outletId, M + half + 10, y, half);
    y += 18;

    // ── Outlet Name (full width, pre-filled) ───────────────────────────────────
    drawField('Outlet Name', outletName, M, y, CW);
    y += 20;

    // ── Declaration box ────────────────────────────────────────────────────────
    const declText =
      'I hereby declare that the address proof submitted for the enrollment of outlet ' +
      outletId + ' — ' + outletName + ' is the correct and valid address proof of the said ' +
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

    doc.save('self-declaration-' + (selectedOutlet?.outletId ?? 'template') + '.pdf');
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
  };

  /* ── D: Submit → OTP step ── */
  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      // Build documents payload
      const documents: { type: string; dataUrl?: string; fileName?: string }[] = [];
      if (docs.businessDoc)    documents.push({ type: 'GST_CERTIFICATE',   dataUrl: docs.businessDoc.dataUrl,    fileName: docs.businessDoc.name });
      if (docs.ownerPhoto)     documents.push({ type: 'SELFIE',            dataUrl: docs.ownerPhoto.dataUrl,     fileName: docs.ownerPhoto.name });
      if (docs.shopAddressDoc) documents.push({ type: 'SHOP_ESTABLISHMENT',dataUrl: docs.shopAddressDoc.dataUrl, fileName: docs.shopAddressDoc.name });
      if (docs.storeBoardPhoto)documents.push({ type: 'OTHER',             dataUrl: docs.storeBoardPhoto.dataUrl,fileName: docs.storeBoardPhoto.name });
      if (docs.cheque)         documents.push({ type: 'CANCELLED_CHEQUE',  dataUrl: docs.cheque.dataUrl,         fileName: docs.cheque.name });
      if (docs.selfDeclaration)documents.push({ type: 'OTHER',             dataUrl: docs.selfDeclaration.dataUrl,fileName: docs.selfDeclaration.name });

      // Capture signature from canvas
      const signatureDataUrl = hasSigned
        ? signatureCanvasRef.current?.toDataURL('image/png') ?? undefined
        : undefined;

      const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
      const res = await fetch('/api/kyc', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
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

      if (res.ok) {
        const responseData = await res.json();
        setSubmissionId(responseData.data?.submissionId ?? null);
      } else {
        const errorData = await res.json().catch(() => ({}));
        console.error('[KYC submit]', errorData);
        // Continue to OTP step even on error in demo mode
      }
    } catch (e) {
      console.error('[KYC submit error]', e);
    } finally {
      setSubmitting(false);
    }
    setSubmitOtpCountdown(30);
    setStep('otp');
  };

  const handleVerifySubmitOtp = async () => {
    // Guard: OTP must be exactly 6 digits (submitOtp.length === 6)
    if (submitOtp.length !== 6) {
      setSubmitOtpError('Please enter a valid 6-digit OTP');
      return;
    }
    setSubmitOtpVerifying(true);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
      const res = await fetch('/api/kyc/consent', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
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
    await new Promise((r) => setTimeout(r, 400));
    setSubmitOtpCountdown(30);
  };

  /* Filtered outlets — excludes dismissed (not interested) outlets */
  const filteredOutlets = ASSIGNED_OUTLETS.filter(
    (o) =>
      !dismissedOutlets.has(o.outletId) && (
        o.name.toLowerCase().includes(outletSearch.toLowerCase()) ||
        o.outletId.toLowerCase().includes(outletSearch.toLowerCase()) ||
        o.beat.toLowerCase().includes(outletSearch.toLowerCase())
      ),
  );

  /* ── Not Interested handler ── */
  const handleConfirmNotInterested = useCallback(async () => {
    if (!confirmNotInterestedId) return;
    const outletName = ASSIGNED_OUTLETS.find((o) => o.outletId === confirmNotInterestedId)?.name ?? confirmNotInterestedId;
    setNotInterestedLoading(true);
    try {
      await fetch('/api/kyc/not-interested', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
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

  /* ── Shared styles ── */
  const inputCls = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)] bg-white';
  const labelCls = 'text-xs font-medium text-gray-600 block mb-1';

  /** Extra classes for a field flagged for re-entry in Re-KYC mode */
  const flagCls = (key: string) =>
    isReKYCFlagged(key)
      ? 'border-amber-400 bg-amber-50 focus:border-amber-500 focus:ring-amber-200/40'
      : '';

  /** Small badge shown next to a flagged field's label */
  const FlagBadge = ({ field }: { field: string }) =>
    isReKYCFlagged(field) ? (
      <span className="ml-1.5 text-[10px] font-semibold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full border border-amber-200 align-middle">
        Re-enter required
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
    return (
      <div>
        <label className={labelCls}>{label} {required && <span className="text-[var(--brand-primary)]">*</span>}</label>
        <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => handleFileSelect(docKey, e)} />
        {!file ? (
          <button type="button" onClick={() => inputRef.current?.click()}
            className="w-full border-2 border-dashed border-gray-200 rounded-xl p-4 flex flex-col items-center gap-2 hover:border-[var(--brand-primary)]/40 hover:bg-green-50/30 transition-colors active:scale-[0.98]">
            <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
              <Upload className="h-5 w-5 text-gray-400" />
            </div>
            <p className="text-xs font-medium text-gray-700">Tap to upload</p>
            <p className="text-[11px] text-gray-400">{hint}</p>
          </button>
        ) : (
          <FilePreview file={file} onRemove={() => removeDoc(docKey)} onReplace={() => inputRef.current?.click()} />
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
    return (
      <div>
        <label className={labelCls}>{label} {required && <span className="text-[var(--brand-primary)]">*</span>}</label>
        {!file ? (
          <button type="button" onClick={() => openCamera(docKey, facing)}
            className="w-full border-2 border-dashed border-[var(--brand-primary)]/30 rounded-xl p-4 flex flex-col items-center gap-2 hover:border-[var(--brand-primary)]/60 hover:bg-green-50/30 transition-colors active:scale-[0.98] bg-green-50/10">
            <div className="w-10 h-10 bg-[var(--brand-primary)]/10 rounded-full flex items-center justify-center">
              <Camera className="h-5 w-5 text-[var(--brand-primary)]" />
            </div>
            <p className="text-xs font-medium text-gray-700">Tap to open camera</p>
            <p className="text-[11px] text-gray-400">{hint}</p>
          </button>
        ) : (
          <FilePreview file={file} onRemove={() => removeDoc(docKey)} onReplace={() => openCamera(docKey, facing)} replaceLabel="Retake" />
        )}
      </div>
    );
  };

  /* ── FilePreview ── */
  const FilePreview = ({
    file, onRemove, onReplace, replaceLabel = 'Change',
  }: {
    file: UploadedFile; onRemove: () => void; onReplace: () => void; replaceLabel?: string;
  }) => (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      {isImage(file) && (
        <div className="h-32 bg-gray-50">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={file.dataUrl} alt={file.name} className="w-full h-full object-contain" />
        </div>
      )}
      {!isImage(file) && (
        <div className="h-16 bg-green-50 flex items-center justify-center gap-2">
          <FileText className="h-6 w-6 text-[var(--brand-primary)]" />
          <span className="text-xs font-medium text-[var(--brand-primary)]">PDF Document</span>
        </div>
      )}
      <div className="flex items-center gap-2 px-3 py-2 bg-white">
        {isImage(file) ? <ImageIcon className="h-4 w-4 text-gray-400 shrink-0" /> : <FileText className="h-4 w-4 text-gray-400 shrink-0" />}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-gray-800 truncate">{file.name}</p>
          <p className="text-[11px] text-gray-400">{formatBytes(file.size)} · compressed</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={onReplace} className="text-[11px] text-[var(--brand-primary)] font-medium hover:underline">{replaceLabel}</button>
          <button type="button" onClick={onRemove} className="p-0.5 rounded-full hover:bg-gray-100 text-gray-400"><X className="h-3.5 w-3.5" /></button>
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
          {selectedOutlet && <p className="text-xs text-gray-400 mt-1">{selectedOutlet.outletId}</p>}
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
            <p className="text-xs font-semibold text-amber-800">Re-KYC mode — some fields need re-entering</p>
            <p className="text-xs text-amber-700 mt-0.5">
              Other fields are pre-filled from the existing KYC.{' '}
              <span className="font-semibold">Fields highlighted in amber must be re-entered.</span>
            </p>
            {selectedOutlet?.reKycRemarks && (
              <p className="text-[11px] text-amber-600 mt-1 italic">Admin note: {selectedOutlet.reKycRemarks}</p>
            )}
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
                      <p className="text-[11px] text-gray-400">{selectedOutlet.outletId} · {TYPE_LABEL[selectedOutlet.type]}</p>
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
                      <div className="px-4 py-8 text-center text-xs text-gray-400">No outlets match your search</div>
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
                            <p className="text-xs text-gray-400">{o.outletId} · {o.beat}</p>
                          </div>
                          <span className="text-[11px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full shrink-0">{TYPE_LABEL[o.type]}</span>
                          {selectedOutlet?.outletId === o.outletId && <Check className="h-4 w-4 text-[var(--brand-primary)] shrink-0" />}
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="px-4 py-2 border-t border-gray-100 bg-gray-50">
                    <p className="text-[11px] text-gray-400">{filteredOutlets.length} of {ASSIGNED_OUTLETS.filter(o => !dismissedOutlets.has(o.outletId)).length} outlets shown</p>
                  </div>
                </div>
              )}
            </div>
            </div>{/* /dropRef wrapper — only covers the dropdown trigger + popup */}

            {selectedOutlet && (
              <div className={`border rounded-xl px-4 py-3 space-y-1.5 ${
                selectedOutlet.kycStatus === 'RE_KYC_REQUIRED'
                  ? 'bg-amber-50 border-amber-200'
                  : 'bg-[var(--brand-primary)]/5 border-[var(--brand-primary)]/20'
              }`}>
                <div className="flex items-center gap-2">
                  <p className={`text-[11px] font-semibold uppercase tracking-wide ${
                    selectedOutlet.kycStatus === 'RE_KYC_REQUIRED' ? 'text-amber-700' : 'text-[var(--brand-primary)]'
                  }`}>Selected</p>
                  {selectedOutlet.kycStatus === 'RE_KYC_REQUIRED' && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 bg-amber-200 text-amber-800 rounded-full">
                      <RefreshCw className="h-2.5 w-2.5" /> Re-KYC Required
                    </span>
                  )}
                </div>
                <p className="text-sm font-bold text-gray-900">{selectedOutlet.name}</p>
                <p className="text-xs text-gray-500">{selectedOutlet.outletId} · {selectedOutlet.beat} · {TYPE_LABEL[selectedOutlet.type]}</p>
                {selectedOutlet.kycStatus === 'RE_KYC_REQUIRED' && selectedOutlet.reKycFlags && (
                  <p className="text-xs text-amber-700">
                    {Object.values(selectedOutlet.reKycFlags).filter(Boolean).length} field(s) flagged for re-entry
                    {selectedOutlet.reKycRemarks && ` — ${selectedOutlet.reKycRemarks}`}
                  </p>
                )}
              </div>
            )}

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
        const outlet = ASSIGNED_OUTLETS.find((o) => o.outletId === confirmNotInterestedId);
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
                  <p className="text-[11px] text-gray-400 truncate">{selectedOutlet?.outletId} · {TYPE_LABEL[selectedOutlet?.type ?? 'SSS']}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--brand-primary)]/5 rounded-lg border border-[var(--brand-primary)]/20 min-w-0">
                <ShieldCheck className="h-3.5 w-3.5 text-[var(--brand-primary)] shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-[var(--brand-primary)] truncate">Trade Loyalty</p>
                  <p className="text-[11px] text-[var(--brand-primary)]/70 truncate">{TYPE_LABEL[selectedOutlet?.type ?? 'SSS']} Programme</p>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Owner name */}
            <div>
              <label className={labelCls}>Owner / Contact Name *<FlagBadge field="ownerName" /></label>
              <input className={`${inputCls} ${flagCls('ownerName')}`} placeholder="Full name" value={form.partnerName} onChange={set('partnerName')} />
            </div>

            {/* Mobile — conflict check only, OTP happens after final submit */}
            <div>
              <label className={labelCls}>Mobile Number *<FlagBadge field="mobileNumber" /></label>
              <div className="flex gap-2">
                <span className="px-3 py-2.5 bg-gray-50 border border-r-0 border-gray-200 rounded-l-xl text-sm text-gray-500 shrink-0">+91</span>
                <input
                  className={`${inputCls} rounded-l-none flex-1 ${
                    mobileCheck === 'ok' ? 'bg-emerald-50 border-emerald-200' :
                    mobileCheck === 'outlet_conflict' || mobileCheck === 'employee_conflict' ? 'border-red-400 bg-red-50 focus:border-red-400 focus:ring-red-200/40' : ''
                  }`}
                  placeholder="9876543210" maxLength={10} value={form.mobile}
                  onChange={handleMobileChange} inputMode="numeric"
                  readOnly={mobileCheck === 'outlet_conflict' || mobileCheck === 'employee_conflict'}
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

            {/* GST */}
            <div>
              <label className={labelCls}>GST Number<FlagBadge field="gstNumber" /></label>
              <input className={`${inputCls} ${flagCls('gstNumber')}`} placeholder="27AAPFU0939F" maxLength={12} value={form.gstNumber} onChange={handleGSTChange} />
              {form.gstNumber.length > 0 && form.gstNumber.length < 12 && (
                <p className="text-[11px] text-amber-600 mt-1 flex items-center gap-1"><AlertCircle className="h-3 w-3" /> {12 - form.gstNumber.length} more characters needed</p>
              )}
            </div>

            {/* PAN */}
            <div>
              <label className={labelCls}>
                PAN Number
                {form.gstNumber.length === 12 && <span className="ml-1.5 text-[11px] text-emerald-600 font-normal">● Auto-filled from GST</span>}
                <FlagBadge field="panNumber" />
              </label>
              <input className={`${inputCls} ${form.gstNumber.length === 12 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : ''} ${flagCls('panNumber')}`}
                placeholder="AAPFU0939F" value={form.panNumber} onChange={set('panNumber')} readOnly={form.gstNumber.length === 12} />
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
                  !docs.ownerPhoto
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
              <label className={labelCls}>Street Address *<FlagBadge field="streetAddress" /></label>
              <input className={`${inputCls} ${flagCls('streetAddress')}`} placeholder="Shop no., street name" value={form.address} onChange={set('address')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>City *<FlagBadge field="city" /></label>
                <input className={`${inputCls} ${flagCls('city')}`} placeholder="City" value={form.city} onChange={set('city')} />
              </div>
              <div>
                <label className={labelCls}>Pincode *<FlagBadge field="pincode" /></label>
                <input className={`${inputCls} ${flagCls('pincode')}`} placeholder="400001" maxLength={6} value={form.pincode} onChange={set('pincode')} inputMode="numeric" />
              </div>
            </div>
            <div>
              <label className={labelCls}>State *<FlagBadge field="state" /></label>
              <input className={`${inputCls} ${flagCls('state')}`} placeholder="Maharashtra" value={form.state} onChange={set('state')} />
            </div>

            <div className="pt-1 space-y-4">
              <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 text-[var(--brand-primary)]" /> Address &amp; Store Documents
              </p>

              {/* Address Proof upload */}
              <FileUploadCard docKey="shopAddressDoc" label="Address Proof" required
                hint="Electricity bill, rent agreement, or govt. address proof · PDF or image · Max 5 MB"
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
                  !boardPhotoGeo
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
            {(isReKYCFlagged('bankName') || isReKYCFlagged('accountNumber') || isReKYCFlagged('ifscCode') || isReKYCFlagged('upiId') || isReKYCFlagged('cancelledCheque')) && (
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
              <div className={isReKYCFlagged('cancelledCheque') ? 'rounded-xl border border-amber-300 p-2 bg-amber-50/40' : ''}>
                {isReKYCFlagged('cancelledCheque') && (
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
                  !paymentGeo
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
