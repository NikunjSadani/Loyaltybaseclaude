'use client';

import React, { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check, ChevronRight, ChevronLeft, MapPin, Upload,
  Save, Send, User, Building2, Phone, CreditCard, FileText,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

type PartnerType = 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

interface KYCFormData {
  // Step 1
  partnerType: PartnerType | '';
  // Step 2
  firmName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  pincode: string;
  geoLat: string;
  geoLng: string;
  // Step 3
  contactName: string;
  mobile: string;
  email: string;
  // Step 4
  panFile: File | null;
  gstFile: File | null;
  chequeFile: File | null;
  outletPhoto: File | null;
  addressProofFile: File | null;
  // Step 5
  accountNumber: string;
  ifscCode: string;
  upiId: string;
}

const INITIAL: KYCFormData = {
  partnerType: '',
  firmName: '', addressLine1: '', addressLine2: '', city: '', state: '', pincode: '',
  geoLat: '', geoLng: '',
  contactName: '', mobile: '', email: '',
  panFile: null, gstFile: null, chequeFile: null, outletPhoto: null, addressProofFile: null,
  accountNumber: '', ifscCode: '', upiId: '',
};

const STEPS = [
  { title: 'Partner Type', icon: User },
  { title: 'Outlet Details', icon: Building2 },
  { title: 'Contact Info', icon: Phone },
  { title: 'Documents', icon: FileText },
  { title: 'Bank Details', icon: CreditCard },
  { title: 'Review', icon: Check },
];

interface KYCFormProps {
  initialData?: Partial<KYCFormData>;
  onSuccess?: () => void;
  redirectOnSuccess?: string;
}

function FileUploadField({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: File | null;
  onChange: (f: File | null) => void;
  required?: boolean;
}) {
  return (
    <div>
      <label className="text-sm font-medium text-gray-700 block mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <label className={cn(
        'flex flex-col items-center gap-2 p-4 rounded-xl border-2 border-dashed cursor-pointer transition-colors',
        value ? 'border-emerald-400 bg-emerald-50' : 'border-gray-200 hover:border-[var(--brand-primary)] hover:bg-[var(--brand-primary)]/5',
      )}>
        <input
          type="file"
          accept="image/*,.pdf"
          className="hidden"
          onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        />
        {value ? (
          <>
            <Check className="h-6 w-6 text-emerald-500" />
            <span className="text-xs font-medium text-emerald-700 text-center truncate max-w-full px-2">
              {value.name}
            </span>
          </>
        ) : (
          <>
            <Upload className="h-6 w-6 text-gray-400" />
            <span className="text-xs text-gray-500 text-center">
              Tap to upload<br />
              <span className="text-[10px] text-gray-400">JPG, PNG, PDF – max 5MB</span>
            </span>
          </>
        )}
      </label>
    </div>
  );
}

export function KYCForm({ initialData, onSuccess, redirectOnSuccess = '/sales/kyc' }: KYCFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [data, setData] = useState<KYCFormData>({ ...INITIAL, ...initialData });
  const [locating, setLocating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);

  const update = useCallback(<K extends keyof KYCFormData>(key: K, value: KYCFormData[K]) => {
    setData((d) => ({ ...d, [key]: value }));
  }, []);

  const captureGeo = () => {
    if (!navigator.geolocation) {
      toast.error('Geolocation not supported');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        update('geoLat', pos.coords.latitude.toFixed(6));
        update('geoLng', pos.coords.longitude.toFixed(6));
        setLocating(false);
        toast.success('Location captured');
      },
      () => {
        setLocating(false);
        toast.error('Failed to get location');
      },
    );
  };

  const handleNext = () => {
    // Basic validation per step
    if (step === 0 && !data.partnerType) {
      toast.error('Please select a partner type');
      return;
    }
    if (step === 1 && (!data.firmName || !data.addressLine1 || !data.city || !data.pincode)) {
      toast.error('Please fill all required outlet fields');
      return;
    }
    if (step === 2 && (!data.contactName || !data.mobile)) {
      toast.error('Please fill contact name and mobile');
      return;
    }
    if (step === 3 && (!data.panFile || !data.gstFile || !data.outletPhoto)) {
      toast.error('PAN, GST certificate and outlet photo are required');
      return;
    }
    if (step === 4 && (!data.accountNumber || !data.ifscCode)) {
      toast.error('Account number and IFSC are required');
      return;
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  const handleSaveDraft = async () => {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 800));
    setSaving(false);
    toast.success('Draft saved');
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 1200));
    setSubmitting(false);
    toast.success('KYC submitted successfully!');
    if (onSuccess) onSuccess();
    else router.push(redirectOnSuccess);
  };

  return (
    <div className="space-y-6">
      {/* Progress indicator */}
      <div className="flex items-center gap-1">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          const done = i < step;
          const active = i === step;
          return (
            <React.Fragment key={i}>
              <div className="flex flex-col items-center gap-1">
                <div
                  className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center transition-colors',
                    done ? 'bg-emerald-500 text-white' :
                    active ? 'bg-[var(--brand-primary)] text-white' : 'bg-gray-100 text-gray-400',
                  )}
                >
                  {done ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                </div>
                <span className={cn(
                  'text-[9px] font-medium hidden sm:block',
                  active ? 'text-[var(--brand-primary)]' : done ? 'text-emerald-600' : 'text-gray-400',
                )}>
                  {s.title}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={cn('flex-1 h-0.5 mb-4', i < step ? 'bg-emerald-400' : 'bg-gray-100')} />
              )}
            </React.Fragment>
          );
        })}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-base font-semibold text-gray-900 mb-5">
          Step {step + 1}: {STEPS[step].title}
        </h2>

        {/* Step 1 – Partner Type */}
        {step === 0 && (
          <div className="space-y-3">
            {[
              { value: 'SSS', label: 'SSS', desc: 'Direct seller to end consumers' },
              { value: 'WHOLESALER', label: 'Wholesaler', desc: 'Bulk distributor to retailers' },
              { value: 'SUB_STOCKIST', label: 'Sub-Stockist', desc: 'Regional distributor under stockist' },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => update('partnerType', opt.value as PartnerType)}
                className={cn(
                  'w-full flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all',
                  data.partnerType === opt.value
                    ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]/5'
                    : 'border-gray-200 hover:border-gray-300',
                )}
              >
                <div
                  className={cn(
                    'w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0',
                    data.partnerType === opt.value
                      ? 'border-[var(--brand-primary)] bg-[var(--brand-primary)]'
                      : 'border-gray-300',
                  )}
                >
                  {data.partnerType === opt.value && (
                    <div className="w-2 h-2 bg-white rounded-full" />
                  )}
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-900">{opt.label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Step 2 – Outlet Details */}
        {step === 1 && (
          <div className="space-y-4">
            <Input
              label="Firm / Outlet Name *"
              value={data.firmName}
              onChange={(e) => update('firmName', e.target.value)}
              placeholder="Kumar General Store"
            />
            <Input
              label="Address Line 1 *"
              value={data.addressLine1}
              onChange={(e) => update('addressLine1', e.target.value)}
              placeholder="Shop no, Street name"
            />
            <Input
              label="Address Line 2"
              value={data.addressLine2}
              onChange={(e) => update('addressLine2', e.target.value)}
              placeholder="Landmark (optional)"
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="City *"
                value={data.city}
                onChange={(e) => update('city', e.target.value)}
                placeholder="Mumbai"
              />
              <Input
                label="State *"
                value={data.state}
                onChange={(e) => update('state', e.target.value)}
                placeholder="Maharashtra"
              />
            </div>
            <Input
              label="PIN Code *"
              value={data.pincode}
              onChange={(e) => update('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="400001"
              inputMode="numeric"
            />
            {/* Geo capture */}
            <div>
              <label className="text-sm font-medium text-gray-700 block mb-1.5">
                Geo Location
              </label>
              <div className="flex gap-3 items-center">
                <Button
                  variant="outline"
                  size="sm"
                  loading={locating}
                  onClick={captureGeo}
                >
                  <MapPin className="h-4 w-4" />
                  Capture Location
                </Button>
                {data.geoLat && (
                  <span className="text-xs text-emerald-600 font-medium">
                    {data.geoLat}, {data.geoLng}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Step 3 – Contact Details */}
        {step === 2 && (
          <div className="space-y-4">
            <Input
              label="Contact Person Name *"
              value={data.contactName}
              onChange={(e) => update('contactName', e.target.value)}
              placeholder="Rajesh Kumar"
            />
            <Input
              label="Mobile Number *"
              value={data.mobile}
              onChange={(e) => update('mobile', e.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="9876543210"
              inputMode="tel"
            />
            <Input
              label="Email Address"
              value={data.email}
              onChange={(e) => update('email', e.target.value)}
              placeholder="rajesh@example.com"
              type="email"
            />
          </div>
        )}

        {/* Step 4 – Document Uploads */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FileUploadField
                label="PAN Card"
                value={data.panFile}
                onChange={(f) => update('panFile', f)}
                required
              />
              <FileUploadField
                label="GST Certificate"
                value={data.gstFile}
                onChange={(f) => update('gstFile', f)}
                required
              />
              <FileUploadField
                label="Cancelled Cheque"
                value={data.chequeFile}
                onChange={(f) => update('chequeFile', f)}
              />
              <FileUploadField
                label="Outlet Photo"
                value={data.outletPhoto}
                onChange={(f) => update('outletPhoto', f)}
                required
              />
            </div>
            <FileUploadField
              label="Address Proof"
              value={data.addressProofFile}
              onChange={(f) => update('addressProofFile', f)}
            />
          </div>
        )}

        {/* Step 5 – Bank Details */}
        {step === 4 && (
          <div className="space-y-4">
            <Input
              label="Account Number *"
              value={data.accountNumber}
              onChange={(e) => update('accountNumber', e.target.value.replace(/\D/g, ''))}
              placeholder="123456789012"
              inputMode="numeric"
            />
            <Input
              label="IFSC Code *"
              value={data.ifscCode}
              onChange={(e) => update('ifscCode', e.target.value.toUpperCase())}
              placeholder="HDFC0001234"
            />
            <Input
              label="UPI ID (optional)"
              value={data.upiId}
              onChange={(e) => update('upiId', e.target.value)}
              placeholder="mobile@upi"
            />
          </div>
        )}

        {/* Step 6 – Review */}
        {step === 5 && (
          <div className="space-y-4">
            {[
              {
                title: 'Partner Type',
                items: [['Type', data.partnerType]],
              },
              {
                title: 'Outlet Details',
                items: [
                  ['Firm Name', data.firmName],
                  ['Address', `${data.addressLine1}, ${data.city} – ${data.pincode}`],
                  ['Location', data.geoLat ? `${data.geoLat}, ${data.geoLng}` : 'Not captured'],
                ],
              },
              {
                title: 'Contact',
                items: [
                  ['Name', data.contactName],
                  ['Mobile', data.mobile],
                  ['Email', data.email || '—'],
                ],
              },
              {
                title: 'Documents',
                items: [
                  ['PAN', data.panFile?.name ?? 'Not uploaded'],
                  ['GST', data.gstFile?.name ?? 'Not uploaded'],
                  ['Cheque', data.chequeFile?.name ?? 'Not uploaded'],
                  ['Outlet Photo', data.outletPhoto?.name ?? 'Not uploaded'],
                ],
              },
              {
                title: 'Bank Details',
                items: [
                  ['Account', data.accountNumber ? `****${data.accountNumber.slice(-4)}` : '—'],
                  ['IFSC', data.ifscCode],
                  ['UPI', data.upiId || '—'],
                ],
              },
            ].map((section) => (
              <div key={section.title} className="bg-gray-50 rounded-xl p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
                  {section.title}
                </p>
                <div className="space-y-2">
                  {section.items.map(([k, v]) => (
                    <div key={k} className="flex items-start justify-between gap-4">
                      <span className="text-xs text-gray-500 shrink-0">{k}</span>
                      <span className="text-xs font-medium text-gray-900 text-right">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Navigation buttons */}
      <div className="flex gap-3">
        {step > 0 && (
          <Button variant="outline" onClick={() => setStep((s) => s - 1)}>
            <ChevronLeft className="h-4 w-4" />
            Back
          </Button>
        )}

        <Button variant="ghost" size="md" loading={saving} onClick={handleSaveDraft}>
          <Save className="h-4 w-4" />
          Save Draft
        </Button>

        <div className="ml-auto">
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={handleNext}>
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button variant="primary" loading={submitting} onClick={handleSubmit}>
              <Send className="h-4 w-4" />
              Submit KYC
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default KYCForm;
