'use client';

import { use, useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, User, MapPin, CreditCard, Check, RefreshCw,
  FileText, Upload, X, AlertCircle, ImageIcon,
  Building2, ShieldCheck, Phone, Clock,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { KYCStatus } from '@/types';
import { BankOrUpiSection, type PaymentMode } from '@/components/bank-or-upi-section';

/* ─── Types ──────────────────────────────────────────────────────────────────── */

type EditStep = 'details' | 'address' | 'bank' | 'done';

interface UploadedFile {
  name: string; size: number; type: string; dataUrl: string;
}

interface DocEntry {
  label:          string;
  originalStatus: 'uploaded' | 'missing' | 'verified';
  action:         'keep' | 'replace' | 'pending'; // pending = must upload
  newFile?:       UploadedFile;
}

interface KYCDetail {
  id:                string;
  partnerName:       string;
  firmName:          string;
  mobile:            string;
  address:           string;
  city:              string;
  state:             string;
  pincode?:          string;
  partnerClass:      string;
  status:            KYCStatus;
  rejectionReason?:  string;
  gstNumber?:        string;
  panNumber?:        string;
  bankName?:         string;
  accountHolderName?: string;
  accountNumber?:    string;
  ifscCode?:         string;
  upiId?:            string;
  paymentMode?:      string;
  documents: { label: string; status: 'uploaded' | 'missing' | 'verified' }[];
}

/* ─── Mock data ──────────────────────────────────────────────────────────────── */

const MOCK_KYC: Record<string, KYCDetail> = {
  k2: {
    id: 'k2', partnerName: 'Amit Sharma', firmName: 'Sharma Kirana',
    mobile: '9765432109', address: '5 Station Road, Borivali', city: 'Mumbai', state: 'Maharashtra', pincode: '400066',
    partnerClass: 'SILVER', status: KYCStatus.PENDING,
    documents: [
      { label: 'GST Certificate', status: 'uploaded' }, { label: 'PAN Card', status: 'uploaded' },
      { label: 'Shop Photo',      status: 'uploaded' }, { label: 'Bank Passbook', status: 'missing' },
    ],
  },
  k3: {
    id: 'k3', partnerName: 'Suresh Patel', firmName: 'Patel Grocery',
    mobile: '9654321098', address: 'Shop 3, MG Road', city: 'Thane', state: 'Maharashtra', pincode: '400601',
    partnerClass: 'BRONZE', status: KYCStatus.REJECTED,
    rejectionReason: 'GST certificate invalid — number mismatch with shop name.',
    documents: [
      { label: 'GST Certificate', status: 'uploaded' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Shop Photo',      status: 'uploaded' }, { label: 'Bank Passbook', status: 'uploaded' },
    ],
  },
  k6: {
    id: 'k6', partnerName: 'Priya Desai', firmName: 'Desai Grocers',
    mobile: '9321098765', address: '1 Old Market, Goregaon', city: 'Mumbai', state: 'Maharashtra', pincode: '400063',
    partnerClass: 'BRONZE', status: KYCStatus.RESUBMISSION_REQUIRED,
    rejectionReason: 'Shop photo is blurry — please re-upload a clear front-facing photo.',
    documents: [
      { label: 'GST Certificate', status: 'verified' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Shop Photo',      status: 'uploaded' }, { label: 'Bank Passbook', status: 'uploaded' },
    ],
  },
  k7: {
    id: 'k7', partnerName: 'Suresh Nair', firmName: 'Suresh Wholesale',
    mobile: '9210987654', address: '11 Station Rd, Kurla', city: 'Mumbai', state: 'Maharashtra', pincode: '400070',
    partnerClass: 'SILVER', status: KYCStatus.RE_KYC_REQUIRED,
    rejectionReason: 'KYC expired — renewal required.',
    gstNumber: '27BBBFU1234F1ZV', panNumber: 'BBBFU1234F',
    bankName: 'SBI', accountNumber: '****3210', ifscCode: 'SBIN0001234',
    documents: [
      { label: 'GST Certificate', status: 'verified' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Shop Photo',      status: 'verified' }, { label: 'Bank Passbook', status: 'verified' },
    ],
  },
  k8: {
    id: 'k8', partnerName: 'Gurpreet Singh', firmName: 'Singh Supermart',
    mobile: '9543210987', address: '78 Link Road, Malad', city: 'Mumbai', state: 'Maharashtra', pincode: '400064',
    partnerClass: 'GOLD', status: KYCStatus.RE_KYC_REQUIRED,
    rejectionReason: 'GST number updated — re-verify required.',
    documents: [
      { label: 'GST Certificate', status: 'uploaded' }, { label: 'PAN Card', status: 'verified' },
      { label: 'Shop Photo',      status: 'verified'  }, { label: 'Bank Passbook', status: 'verified' },
    ],
  },
};

const OUTLET_MAP: Record<string, string> = {
  o2: 'k2', o3: 'k3', o6: 'k6', o7: 'k7', o8: 'k8',
};

/* ─── Helpers ────────────────────────────────────────────────────────────────── */

const STEP_LABELS: Record<EditStep, string> = {
  details: 'Details',
  address: 'Address',
  bank:    'Bank',
  done:    'Done',
};
const STEPS: EditStep[] = ['details', 'address', 'bank'];

function formatBytes(b: number) {
  return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
}

function isImage(f: UploadedFile) { return f.type.startsWith('image/'); }

/* ─── Status banner config ───────────────────────────────────────────────────── */

const STATUS_BANNER: Partial<Record<KYCStatus, {
  title: string; icon: React.ReactNode;
  bg: string; border: string; text: string;
}>> = {
  [KYCStatus.RE_KYC_REQUIRED]: {
    title:  'Re-KYC Required',
    icon:   <RefreshCw className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />,
    bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700',
  },
  [KYCStatus.REJECTED]: {
    title:  'Fix & Resubmit',
    icon:   <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />,
    bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700',
  },
  [KYCStatus.RESUBMISSION_REQUIRED]: {
    title:  'Re-upload Required',
    icon:   <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />,
    bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700',
  },
  [KYCStatus.PENDING]: {
    title:  'Complete Your KYC Submission',
    icon:   <Clock className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />,
    bg: 'bg-blue-50', border: 'border-blue-100', text: 'text-blue-700',
  },
};

/* ─── Page ───────────────────────────────────────────────────────────────────── */

export default function EditKYCPage({ params }: { params: Promise<{ id: string }> }) {
  const { id }     = use(params);
  const router     = useRouter();
  const resolvedId = OUTLET_MAP[id] ?? id;
  const kyc        = MOCK_KYC[resolvedId];

  const [step,       setStep]       = useState<EditStep>('details');
  const [submitting, setSubmitting] = useState(false);

  /* ── Form state (pre-filled) ── */
  const [form, setForm] = useState({
    partnerName:       kyc?.partnerName       ?? '',
    mobile:            kyc?.mobile            ?? '',
    partnerClass:      kyc?.partnerClass      ?? 'SSS',
    gstNumber:         kyc?.gstNumber         ?? '',
    panNumber:         kyc?.panNumber         ?? '',
    address:           kyc?.address           ?? '',
    city:              kyc?.city              ?? '',
    state:             kyc?.state             ?? '',
    pincode:           kyc?.pincode           ?? '',
    bankName:          kyc?.bankName          ?? '',
    accountHolderName: kyc?.accountHolderName ?? '',
    accountNumber:     kyc?.accountNumber     ?? '',
    ifscCode:          kyc?.ifscCode          ?? '',
    upiId:             kyc?.upiId             ?? '',
  });

  const [paymentMode, setPaymentMode] = useState<PaymentMode>(
    kyc?.paymentMode === 'upi' ? 'upi' : 'bank',
  );

  /* ── Mobile verification ── */
  const originalMobile                        = kyc?.mobile ?? '';
  const [phoneVerified, setPhoneVerified]     = useState(true); // existing mobile = pre-verified
  const [otpSent,       setOtpSent]           = useState(false);
  const [otp,           setOtp]               = useState('');
  const [otpError,      setOtpError]          = useState('');
  const [otpCountdown,  setOtpCountdown]      = useState(0);
  const [otpVerifying,  setOtpVerifying]      = useState(false);

  /* ── Document state ── */
  const [docs, setDocs] = useState<DocEntry[]>(
    (kyc?.documents ?? []).map(d => ({
      label:          d.label,
      originalStatus: d.status,
      action:         d.status === 'missing' ? 'pending' : 'keep',
    })),
  );

  const fileRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  /* OTP countdown ticker */
  useEffect(() => {
    if (otpCountdown <= 0) return;
    const t = setInterval(() => setOtpCountdown(c => c - 1), 1000);
    return () => clearInterval(t);
  }, [otpCountdown]);

  if (!kyc) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <AlertCircle className="h-10 w-10 text-amber-400" />
        <p className="text-gray-500 text-sm">KYC record not found.</p>
        <Link href="/sales/kyc"><Button variant="outline" size="sm">← Back to list</Button></Link>
      </div>
    );
  }

  const banner = STATUS_BANNER[kyc.status];

  /* ── Helpers ── */
  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }));

  const handleGSTChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const gst = e.target.value.toUpperCase().slice(0, 12);
    setForm(f => ({ ...f, gstNumber: gst, panNumber: gst.length === 12 ? gst.substring(2, 12) : f.panNumber }));
  };

  const handleMobileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value.replace(/\D/g, '').slice(0, 10);
    setForm(f => ({ ...f, mobile: val }));
    if (val === originalMobile) {
      setPhoneVerified(true);
      setOtpSent(false);
      setOtp('');
      setOtpError('');
    } else {
      setPhoneVerified(false);
      setOtpSent(false);
      setOtp('');
      setOtpError('');
    }
  };

  const handleSendOTP = async () => {
    setOtpSent(true);
    setOtpCountdown(30);
    setOtpError('');
    setOtp('');
  };

  const handleVerifyOTP = async () => {
    setOtpVerifying(true);
    await new Promise(r => setTimeout(r, 800));
    setOtpVerifying(false);
    if (otp.length === 6) {
      setPhoneVerified(true);
      setOtpError('');
    } else {
      setOtpError('Incorrect OTP. Please try again.');
    }
  };

  const handleDocFile = (label: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setDocs(prev => prev.map(d =>
        d.label === label
          ? { ...d, action: d.originalStatus === 'verified' ? 'replace' : 'pending', newFile: { name: file.name, size: file.size, type: file.type, dataUrl: reader.result as string } }
          : d,
      ));
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const clearDocFile = (label: string) => {
    setDocs(prev => prev.map(d =>
      d.label === label
        ? { ...d, action: d.originalStatus === 'verified' ? 'keep' : (d.originalStatus === 'missing' ? 'pending' : 'keep'), newFile: undefined }
        : d,
    ));
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      // Build documents payload — only include files being replaced/added
      const documents = docs
        .filter(d => d.action === 'replace' || (d.action === 'pending' && d.newFile))
        .map(d => ({
          label:   d.label,
          dataUrl: d.newFile?.dataUrl,
          fileName:d.newFile?.name,
        }));

      const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
      const res = await fetch(`/api/kyc/${kyc.id}`, {
        method:  'PATCH',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          // Partner & address details
          partnerName:      form.partnerName,
          mobile:           form.mobile,
          gstNumber:        form.gstNumber,
          panNumber:        form.panNumber,
          address:          form.address,
          city:             form.city,
          state:            form.state,
          pincode:          form.pincode,
          // Bank / UPI details (updated)
          paymentMode:      paymentMode,
          bankName:         form.bankName,
          accountHolderName:form.accountHolderName,
          accountNumber:    form.accountNumber,
          ifscCode:         form.ifscCode,
          upiId:            form.upiId,
          // Documents being replaced
          documents,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.error('[KYC edit submit]', errorData);
        // Fall through to show done screen anyway in demo mode
      }
    } catch (e) {
      console.error('[KYC edit submit error]', e);
    } finally {
      setSubmitting(false);
    }
    setStep('done');
  };

  /* ── Validation ── */
  const docsReady = docs.every(d =>
    d.action === 'keep' ||
    d.action === 'replace' && d.newFile ||
    d.action === 'pending' && d.newFile,
  );
  const step1Valid = !!form.partnerName && phoneVerified && docsReady;
  const step2Valid = !!form.address && !!form.city;
  const step3Valid = paymentMode === 'upi'
    ? !!form.upiId
    : !!form.bankName && !!form.accountHolderName && !!form.accountNumber && !!form.ifscCode;

  /* ── Step bar ── */
  const StepBar = () => (
    <div className="flex items-center gap-1">
      {STEPS.map((s, i) => {
        const currentIdx = STEPS.indexOf(step);
        const isDone   = currentIdx > i;
        const isActive = step === s;
        return (
          <React.Fragment key={s}>
            <div className={`flex items-center gap-1 text-[11px] font-medium ${
              isActive ? 'text-[#16a34a]' : isDone ? 'text-emerald-600' : 'text-gray-400'
            }`}>
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                isActive ? 'bg-[#16a34a] text-white' : isDone ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500'
              }`}>
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

  const inputCls = 'w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#16a34a]/20 focus:border-[#16a34a] bg-white';
  const labelCls = 'text-xs font-medium text-gray-600 block mb-1';

  /* ── Done screen ── */
  if (step === 'done') {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-5 text-center fade-in">
        <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center">
          <Check className="h-8 w-8 text-emerald-600" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">KYC Resubmitted!</h2>
          <p className="text-sm text-gray-500 mt-1">
            {kyc.firmName} has been resubmitted for review.
            <br />You'll be notified once it's approved.
          </p>
          <p className="text-xs text-gray-400 mt-1">{kyc.id}</p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={() => router.push(`/sales/kyc/${id}`)}>View KYC</Button>
          <Button variant="primary" onClick={() => router.push('/sales/kyc')}>Back to List</Button>
        </div>
      </div>
    );
  }

  /* ── Document card ── */
  const DocCard = ({ doc }: { doc: DocEntry }) => {
    const needsUpload = doc.action === 'pending' && !doc.newFile;
    return (
      <div>
        {/* Hidden file input */}
        <input
          ref={el => { if (el) fileRefs.current.set(doc.label, el); else fileRefs.current.delete(doc.label); }}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={e => handleDocFile(doc.label, e)}
        />

        <div className={`rounded-xl border overflow-hidden ${needsUpload ? 'border-red-200' : 'border-gray-200'}`}>
          {/* Doc header row */}
          <div className={`flex items-center justify-between px-3 py-2.5 ${needsUpload ? 'bg-red-50' : 'bg-gray-50'}`}>
            <div className="flex items-center gap-2 min-w-0">
              <FileText className={`h-3.5 w-3.5 shrink-0 ${needsUpload ? 'text-red-400' : 'text-gray-400'}`} />
              <span className="text-xs font-semibold text-gray-700 truncate">{doc.label}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Status chip */}
              {doc.originalStatus === 'verified' && doc.action === 'keep' && (
                <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full">✓ Verified</span>
              )}
              {doc.originalStatus === 'uploaded' && doc.action === 'keep' && !doc.newFile && (
                <span className="text-[10px] font-semibold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded-full">Previously uploaded</span>
              )}
              {doc.action === 'pending' && !doc.newFile && (
                <span className="text-[10px] font-semibold text-red-600 bg-red-100 px-1.5 py-0.5 rounded-full">Required</span>
              )}
              {doc.newFile && (
                <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full">✓ Uploaded</span>
              )}

              {/* Upload / Replace / Keep toggle */}
              {!doc.newFile ? (
                <button
                  type="button"
                  onClick={() => fileRefs.current.get(doc.label)?.click()}
                  className="text-[10px] font-semibold text-[#16a34a] hover:underline flex items-center gap-0.5"
                >
                  <Upload className="h-3 w-3" />
                  {doc.originalStatus === 'missing' ? 'Upload' : 'Replace'}
                </button>
              ) : (
                <button type="button" onClick={() => clearDocFile(doc.label)}
                  className="p-0.5 rounded-full hover:bg-gray-200 text-gray-400">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* New file preview */}
          {doc.newFile && (
            <div className="px-3 py-2 bg-white flex items-center gap-2 border-t border-gray-100">
              {isImage(doc.newFile)
                ? <ImageIcon className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                : <FileText  className="h-3.5 w-3.5 text-gray-400 shrink-0" />}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-gray-800 truncate">{doc.newFile.name}</p>
                <p className="text-[10px] text-gray-400">{formatBytes(doc.newFile.size)}</p>
              </div>
              <button type="button" onClick={() => fileRefs.current.get(doc.label)?.click()}
                className="text-[10px] text-[#16a34a] font-medium hover:underline shrink-0">Change</button>
            </div>
          )}
        </div>
      </div>
    );
  };

  /* ── Page shell ── */
  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={`/sales/kyc/${id}`} className="p-2 rounded-lg hover:bg-gray-100 transition-colors">
          <ArrowLeft className="h-4 w-4 text-gray-600" />
        </Link>
        <div>
          <h1 className="text-lg font-bold text-gray-900">
            {kyc.status === KYCStatus.RE_KYC_REQUIRED ? 'Re-KYC' :
             kyc.status === KYCStatus.PENDING          ? 'Complete KYC' : 'Edit KYC'}
          </h1>
          <p className="text-xs text-gray-500">{kyc.firmName} · {kyc.id}</p>
        </div>
      </div>

      {/* Status banner */}
      {banner && (
        <div className={`${banner.bg} border ${banner.border} rounded-xl px-4 py-3 flex items-start gap-2`}>
          {banner.icon}
          <div className="flex-1">
            <p className={`text-sm font-semibold ${banner.text}`}>{banner.title}</p>
            {kyc.rejectionReason && (
              <p className={`text-xs mt-0.5 ${banner.text} opacity-80`}>{kyc.rejectionReason}</p>
            )}
          </div>
        </div>
      )}

      <StepBar />

      {/* ════════════════════════════════════════════════════════════════════════
          Step 1 — Details
      ════════════════════════════════════════════════════════════════════════ */}
      {step === 'details' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <User className="h-4 w-4" /> Partner Details
            </CardTitle>
            {/* Outlet chip — locked */}
            <div className="mt-2 flex items-center gap-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200 w-fit max-w-full">
              <Building2 className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              <span className="text-xs font-semibold text-gray-700 truncate">{kyc.firmName}</span>
              <span className="text-[10px] text-gray-400 shrink-0">{kyc.id} · {kyc.partnerClass}</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">

            {/* Owner name */}
            <div>
              <label className={labelCls}>Owner / Contact Name *</label>
              <input className={inputCls} placeholder="Full name" value={form.partnerName} onChange={set('partnerName')} />
            </div>

            {/* Mobile */}
            <div>
              <label className={labelCls}>
                Mobile Number *
                {phoneVerified && form.mobile === originalMobile && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-emerald-600 font-semibold">
                    <ShieldCheck className="h-3 w-3" /> Previously verified
                  </span>
                )}
                {phoneVerified && form.mobile !== originalMobile && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-emerald-600 font-semibold">
                    <ShieldCheck className="h-3 w-3" /> Verified
                  </span>
                )}
              </label>
              <div className="flex gap-2">
                <span className="px-3 py-2.5 bg-gray-50 border border-r-0 border-gray-200 rounded-l-xl text-sm text-gray-500 shrink-0">+91</span>
                <input
                  className={`${inputCls} rounded-l-none flex-1 ${phoneVerified ? 'bg-emerald-50 border-emerald-200' : ''}`}
                  placeholder="9876543210"
                  maxLength={10}
                  value={form.mobile}
                  onChange={handleMobileChange}
                  inputMode="numeric"
                />
                {!phoneVerified && form.mobile.length === 10 && !otpSent && (
                  <Button variant="primary" size="sm" className="shrink-0" onClick={handleSendOTP}>
                    Send OTP
                  </Button>
                )}
                {!phoneVerified && otpSent && (
                  <Button variant="outline" size="sm" className="shrink-0 text-xs"
                    onClick={handleSendOTP} disabled={otpCountdown > 0}>
                    {otpCountdown > 0 ? `${otpCountdown}s` : 'Resend'}
                  </Button>
                )}
                {phoneVerified && <div className="flex items-center px-2 shrink-0"><ShieldCheck className="h-5 w-5 text-emerald-500" /></div>}
              </div>
              {/* OTP entry */}
              {otpSent && !phoneVerified && (
                <div className="mt-3 bg-blue-50 border border-blue-100 rounded-xl px-4 py-4 space-y-3">
                  <div className="flex items-start gap-2">
                    <Phone className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-blue-700">
                      OTP sent to <span className="font-semibold">+91 {form.mobile}</span>.
                      {otpCountdown > 0 && <span className="text-blue-400"> Resend in {otpCountdown}s.</span>}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      className="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-center font-mono tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-[#16a34a]/20 focus:border-[#16a34a] bg-white"
                      placeholder="· · · ·"
                      maxLength={6}
                      value={otp}
                      onChange={e => { setOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setOtpError(''); }}
                      inputMode="numeric"
                    />
                    <Button variant="primary" size="sm" className="shrink-0 px-5"
                      loading={otpVerifying} disabled={otp.length !== 6} onClick={handleVerifyOTP}>
                      Verify
                    </Button>
                  </div>
                  {otpError && <p className="text-xs text-red-600 flex items-center gap-1"><AlertCircle className="h-3 w-3" />{otpError}</p>}
                </div>
              )}
            </div>

            {/* Partner type */}
            <div>
              <label className={labelCls}>Partner Type *</label>
              <select className={inputCls} value={form.partnerClass} onChange={set('partnerClass')}>
                <option value="RETAILER">Retailer</option>
                <option value="WHOLESALER">Wholesaler</option>
                <option value="SUB_STOCKIST">Sub-Stockist</option>
              </select>
            </div>

            {/* GST + PAN */}
            <div>
              <label className={labelCls}>GST Number</label>
              <input className={inputCls} placeholder="27AAPFU0939F" maxLength={12} value={form.gstNumber} onChange={handleGSTChange} />
              {form.gstNumber.length > 0 && form.gstNumber.length < 12 && (
                <p className="text-[10px] text-amber-600 mt-1 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> {12 - form.gstNumber.length} more characters needed
                </p>
              )}
            </div>
            <div>
              <label className={labelCls}>
                PAN Number
                {form.gstNumber.length === 12 && <span className="ml-1.5 text-[10px] text-emerald-600 font-normal">● Auto-filled from GST</span>}
              </label>
              <input
                className={`${inputCls} ${form.gstNumber.length === 12 ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : ''}`}
                placeholder="AAPFU0939F"
                value={form.panNumber}
                onChange={set('panNumber')}
                readOnly={form.gstNumber.length === 12}
              />
            </div>

            {/* Documents */}
            <div className="pt-1 space-y-3">
              <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 text-[#16a34a]" /> KYC Documents
              </p>
              <p className="text-[10px] text-gray-400 -mt-1">
                Verified documents are kept automatically. Re-upload only what needs updating.
              </p>
              {docs.map(doc => <DocCard key={doc.label} doc={doc} />)}
            </div>

            <div className="flex gap-3 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => router.push(`/sales/kyc/${id}`)}>← Cancel</Button>
              <Button variant="primary" className="flex-1" disabled={!step1Valid} onClick={() => setStep('address')}>
                Continue →
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          Step 2 — Address
      ════════════════════════════════════════════════════════════════════════ */}
      {step === 'address' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <MapPin className="h-4 w-4" /> Shop Address
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className={labelCls}>Street Address *</label>
              <input className={inputCls} placeholder="Shop no., street name" value={form.address} onChange={set('address')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>City *</label>
                <input className={inputCls} placeholder="City" value={form.city} onChange={set('city')} />
              </div>
              <div>
                <label className={labelCls}>Pincode</label>
                <input className={inputCls} placeholder="400001" maxLength={6} value={form.pincode} onChange={set('pincode')} inputMode="numeric" />
              </div>
            </div>
            <div>
              <label className={labelCls}>State *</label>
              <input className={inputCls} placeholder="Maharashtra" value={form.state} onChange={set('state')} />
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setStep('details')}>← Back</Button>
              <Button variant="primary" className="flex-1" disabled={!step2Valid} onClick={() => setStep('bank')}>
                Continue →
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ════════════════════════════════════════════════════════════════════════
          Step 3 — Bank
      ════════════════════════════════════════════════════════════════════════ */}
      {step === 'bank' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <CreditCard className="h-4 w-4" /> Bank Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <BankOrUpiSection
              paymentMode={paymentMode}
              onPaymentModeChange={setPaymentMode}
              bankName={form.bankName}
              accountHolderName={form.accountHolderName}
              accountNumber={form.accountNumber}
              ifscCode={form.ifscCode}
              onFieldChange={(field) => set(field as keyof typeof form)}
              upiId={form.upiId}
              onUpiChange={(val) => setForm(f => ({ ...f, upiId: val }))}
            >
              {/* Cancelled cheque document — shown inside bank mode */}
              {(() => {
                const chequeDoc = docs.find(d => d.label === 'Bank Passbook' || d.label === 'Cancelled Cheque');
                if (!chequeDoc) return null;
                return (
                  <div>
                    <DocCard doc={chequeDoc} />
                    <p className="text-xs text-gray-400 mt-1.5">Used to verify bank account details before payout.</p>
                  </div>
                );
              })()}
            </BankOrUpiSection>

            <p className="text-xs text-gray-400 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
              By resubmitting, you confirm all the information is accurate and the documents are valid.
            </p>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setStep('address')}>← Back</Button>
              <Button
                variant="primary"
                className="flex-1"
                loading={submitting}
                disabled={!step3Valid}
                onClick={handleSubmit}
              >
                Resubmit KYC
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Needed for StepBar JSX inside the component
import React from 'react';
