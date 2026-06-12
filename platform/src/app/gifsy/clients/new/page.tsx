'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, AlertCircle, Building2 } from 'lucide-react';
import { CLIENT_REGISTRY } from '@/lib/platform/client-registry';
import { validateNewClientSlug } from '@/lib/platform/platform-admin';
import type { FeatureKey } from '@/lib/platform/client-config';

// ─────────────────────────────────────────────────────────────────────────────
// Step types
// ─────────────────────────────────────────────────────────────────────────────

type Step = 'identity' | 'branding' | 'features' | 'review';

interface OnboardingForm {
  // Identity
  slug: string;
  internalName: string;
  status: 'ACTIVE' | 'ONBOARDING' | 'INACTIVE';

  // Branding
  displayName: string;
  primaryColor: string;
  supportEmail: string;
  supportPhone: string;
  invoicePrefix: string;

  // Features
  features: Record<FeatureKey, boolean>;
}

const DEFAULT_FEATURES: Record<FeatureKey, boolean> = {
  visibilityInvoiceModule: true,
  kycApprovalFlow:         true,
  campaignEnrollmentForm:  true,
  salesTeamApp:            true,
  walletModule:            true,
  referralModule:          false,
  selfEnrollmentAllowed:   true,
  nonKycOutletCampaigns:   false,
  multiLevelApproval:      true,
};

const FEATURE_META: Record<FeatureKey, { label: string; description: string }> = {
  visibilityInvoiceModule:  { label: 'Invoice Module',       description: 'GST invoice generation and download for partners' },
  kycApprovalFlow:          { label: 'KYC Approval Flow',    description: 'Multi-level KYC verification workflow for outlets' },
  campaignEnrollmentForm:   { label: 'Enrollment Forms',     description: 'Open / mixed campaigns with custom enrollment forms' },
  salesTeamApp:             { label: 'Sales Team App',       description: 'Mobile app access for sales officers' },
  walletModule:             { label: 'Wallet Module',        description: 'Points wallet, redemption & payout' },
  referralModule:           { label: 'Referral Module',      description: 'Outlet-referral rewards and tracking' },
  selfEnrollmentAllowed:    { label: 'Self-Enrollment',      description: 'Partners can self-accept schemes' },
  nonKycOutletCampaigns:    { label: 'Non-KYC Campaigns',   description: 'Campaigns can target non-KYC outlets' },
  multiLevelApproval:       { label: 'Multi-Level Approval', description: 'Require two or more approval levels' },
};

const STEPS: { key: Step; label: string }[] = [
  { key: 'identity', label: 'Identity' },
  { key: 'branding', label: 'Branding' },
  { key: 'features', label: 'Features' },
  { key: 'review',   label: 'Review' },
];

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30';

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function OnboardClientPage() {
  const [step, setStep] = useState<Step>('identity');
  const [submitted, setSubmitted] = useState(false);

  const [form, setForm] = useState<OnboardingForm>({
    slug:          '',
    internalName:  '',
    status:        'ONBOARDING',
    displayName:   '',
    primaryColor:  '#2563eb',
    supportEmail:  '',
    supportPhone:  '',
    invoicePrefix: 'TGSL-',
    features:      { ...DEFAULT_FEATURES },
  });

  const [slugErrors, setSlugErrors] = useState<string[]>([]);

  const updateForm = (patch: Partial<OnboardingForm>) =>
    setForm((p) => ({ ...p, ...patch }));

  const currentStepIndex = STEPS.findIndex((s) => s.key === step);

  const goNext = () => {
    if (step === 'identity') {
      const errs = validateNewClientSlug(form.slug, CLIENT_REGISTRY);
      setSlugErrors(errs);
      if (errs.length > 0) return;
    }
    const nextIndex = currentStepIndex + 1;
    if (nextIndex < STEPS.length) setStep(STEPS[nextIndex].key);
  };

  const goBack = () => {
    const prevIndex = currentStepIndex - 1;
    if (prevIndex >= 0) setStep(STEPS[prevIndex].key);
  };

  const submit = () => {
    // In Phase 2 this will call a server action to persist to DB
    setSubmitted(true);
  };

  if (submitted) {
    return <SuccessScreen form={form} />;
  }

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Breadcrumb */}
      <div>
        <Link
          href="/gifsy/clients"
          className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-white/70 transition-colors mb-3"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Clients
        </Link>
        <h1 className="text-xl font-bold text-white">Onboard New Client</h1>
        <p className="text-sm text-white/50 mt-0.5">Configure a new tenant on the Gifsy Loyalty Platform.</p>
      </div>

      {/* Progress stepper */}
      <div className="flex items-center gap-0">
        {STEPS.map((s, idx) => {
          const done    = idx < currentStepIndex;
          const current = s.key === step;
          return (
            <div key={s.key} className="flex items-center">
              <div className="flex flex-col items-center">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                  done    ? 'bg-[var(--brand-primary)] text-white'
                  : current ? 'bg-white/20 text-white ring-2 ring-[var(--brand-primary)]'
                  : 'bg-white/10 text-white/30'
                }`}>
                  {done ? <Check className="w-3.5 h-3.5" /> : idx + 1}
                </div>
                <span className={`text-xs mt-1 ${current ? 'text-white' : done ? 'text-white/60' : 'text-white/30'}`}>
                  {s.label}
                </span>
              </div>
              {idx < STEPS.length - 1 && (
                <div className={`w-16 h-px mx-2 mb-5 ${idx < currentStepIndex ? 'bg-[var(--brand-primary)]/60' : 'bg-white/10'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step panel */}
      <div className="border border-white/10 rounded-xl p-6">
        {step === 'identity' && (
          <IdentityStep form={form} onChange={updateForm} errors={slugErrors} />
        )}
        {step === 'branding' && (
          <BrandingStep form={form} onChange={updateForm} />
        )}
        {step === 'features' && (
          <FeaturesStep form={form} onChange={updateForm} />
        )}
        {step === 'review' && (
          <ReviewStep form={form} />
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between">
        <button
          onClick={goBack}
          disabled={currentStepIndex === 0}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-white/50 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />Back
        </button>
        {step === 'review' ? (
          <button
            onClick={submit}
            className="flex items-center gap-1.5 px-5 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
          >
            <Check className="w-4 h-4" />Onboard Client
          </button>
        ) : (
          <button
            onClick={goNext}
            className="flex items-center gap-1.5 px-4 py-2 bg-white/10 border border-white/20 text-white text-sm font-medium rounded-lg hover:bg-white/15 transition-colors"
          >
            Next
            <ArrowRight className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step: Identity
// ─────────────────────────────────────────────────────────────────────────────

function IdentityStep({
  form, onChange, errors,
}: {
  form: OnboardingForm;
  onChange: (p: Partial<OnboardingForm>) => void;
  errors: string[];
}) {
  return (
    <div className="space-y-4">
      <StepHeader title="Client Identity" description="Basic identifiers for the new client tenant." />

      <Field label="Slug" hint="Lowercase, alphanumeric, hyphens only. Drives the subdomain (e.g. clientb.loyaltybase.in).">
        <input
          value={form.slug}
          onChange={(e) => onChange({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
          placeholder="e.g. reliance-retail"
          className={INPUT_CLS}
        />
        {errors.map((e, i) => (
          <p key={i} className="flex items-center gap-1 text-xs text-red-400 mt-1">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />{e}
          </p>
        ))}
        {form.slug && errors.length === 0 && (
          <p className="text-xs text-green-400 mt-1 flex items-center gap-1">
            <Check className="w-3.5 h-3.5" />
            Domain: <span className="font-mono">{form.slug}.loyaltybase.in</span>
          </p>
        )}
      </Field>

      <Field label="Internal name" hint="How this client appears in Gifsy super-admin.">
        <input
          value={form.internalName}
          onChange={(e) => onChange({ internalName: e.target.value })}
          placeholder="e.g. Reliance Retail Ltd."
          className={INPUT_CLS}
        />
      </Field>

      <Field label="Initial status">
        <select
          value={form.status}
          onChange={(e) => onChange({ status: e.target.value as OnboardingForm['status'] })}
          className={INPUT_CLS}
        >
          <option value="ONBOARDING">Onboarding</option>
          <option value="ACTIVE">Active</option>
          <option value="INACTIVE">Inactive</option>
        </select>
      </Field>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step: Branding
// ─────────────────────────────────────────────────────────────────────────────

function BrandingStep({
  form, onChange,
}: {
  form: OnboardingForm;
  onChange: (p: Partial<OnboardingForm>) => void;
}) {
  return (
    <div className="space-y-4">
      <StepHeader title="Branding" description="Partner-facing name and visual identity." />

      <Field label="Display name" hint="What retailers see in the partner app header.">
        <input
          value={form.displayName}
          onChange={(e) => onChange({ displayName: e.target.value })}
          placeholder="e.g. Reliance Loyalty"
          className={INPUT_CLS}
        />
      </Field>

      <Field label="Primary colour">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={form.primaryColor}
            onChange={(e) => onChange({ primaryColor: e.target.value })}
            className="w-9 h-9 rounded-lg border border-white/20 bg-transparent cursor-pointer p-0.5"
          />
          <input
            value={form.primaryColor}
            onChange={(e) => onChange({ primaryColor: e.target.value })}
            placeholder="#2563eb"
            className={INPUT_CLS + ' flex-1 font-mono'}
          />
          <div className="w-9 h-9 rounded-lg shrink-0" style={{ backgroundColor: form.primaryColor }} />
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Support email">
          <input
            value={form.supportEmail}
            onChange={(e) => onChange({ supportEmail: e.target.value })}
            placeholder={`support@${form.slug || 'client'}.loyaltybase.in`}
            className={INPUT_CLS}
          />
        </Field>
        <Field label="Support phone">
          <input
            value={form.supportPhone}
            onChange={(e) => onChange({ supportPhone: e.target.value })}
            placeholder="+91-1800-XXX-XXXX"
            className={INPUT_CLS}
          />
        </Field>
      </div>

      <Field label="Invoice prefix" hint="Prepended to every invoice number (e.g. TGSL-REL-0001).">
        <input
          value={form.invoicePrefix}
          onChange={(e) => onChange({ invoicePrefix: e.target.value.toUpperCase() })}
          placeholder="TGSL-XXX"
          className={INPUT_CLS + ' font-mono'}
        />
      </Field>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step: Features
// ─────────────────────────────────────────────────────────────────────────────

function FeaturesStep({
  form, onChange,
}: {
  form: OnboardingForm;
  onChange: (p: Partial<OnboardingForm>) => void;
}) {
  const toggle = (key: FeatureKey, value: boolean) =>
    onChange({ features: { ...form.features, [key]: value } });

  const enabledCount = Object.values(form.features).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <StepHeader
        title="Feature Flags"
        description={`Choose which modules this client has access to. ${enabledCount}/9 enabled.`}
      />
      <div className="space-y-2">
        {(Object.keys(FEATURE_META) as FeatureKey[]).map((key) => {
          const on   = form.features[key];
          const meta = FEATURE_META[key];
          return (
            <div
              key={key}
              className={`flex items-center gap-4 px-4 py-3 rounded-xl border transition-colors cursor-pointer ${
                on ? 'bg-white/5 border-white/15' : 'bg-transparent border-white/5 hover:border-white/10'
              }`}
              onClick={() => toggle(key, !on)}
            >
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${on ? 'text-white' : 'text-white/50'}`}>{meta.label}</p>
                <p className="text-xs text-white/30 mt-0.5">{meta.description}</p>
              </div>
              <Toggle enabled={on} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Step: Review
// ─────────────────────────────────────────────────────────────────────────────

function ReviewStep({ form }: { form: OnboardingForm }) {
  const enabledFeatures = (Object.keys(FEATURE_META) as FeatureKey[]).filter((k) => form.features[k]);

  return (
    <div className="space-y-5">
      <StepHeader title="Review & Confirm" description="Double-check the configuration before onboarding." />

      <div className="space-y-3">
        <ReviewSection title="Identity">
          <ReviewRow label="Slug"         value={form.slug} mono />
          <ReviewRow label="Internal name" value={form.internalName} />
          <ReviewRow label="Status"        value={form.status} />
          <ReviewRow label="Domain"        value={`${form.slug}.loyaltybase.in`} mono />
        </ReviewSection>

        <ReviewSection title="Branding">
          <ReviewRow label="Display name"  value={form.displayName} />
          <ReviewRow label="Primary colour" value={form.primaryColor} mono />
          <ReviewRow label="Invoice prefix" value={form.invoicePrefix} mono />
          {form.supportEmail && <ReviewRow label="Support email" value={form.supportEmail} />}
        </ReviewSection>

        <ReviewSection title="Features">
          <div className="flex flex-wrap gap-1.5">
            {enabledFeatures.map((k) => (
              <span key={k} className="px-2 py-0.5 rounded-full bg-[var(--brand-primary)]/20 text-[var(--brand-primary)] text-xs font-medium border border-[var(--brand-primary)]/30">
                {FEATURE_META[k].label}
              </span>
            ))}
            {enabledFeatures.length === 0 && <span className="text-xs text-white/30">No features enabled</span>}
          </div>
        </ReviewSection>

        <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl px-4 py-3 text-xs text-blue-300">
          After onboarding: provision DNS <code className="font-mono">{form.slug}.loyaltybase.in</code>, upload logo, and configure MSG91 credentials in environment variables.
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Success screen
// ─────────────────────────────────────────────────────────────────────────────

function SuccessScreen({ form }: { form: OnboardingForm }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-5 text-center">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold text-white"
        style={{ backgroundColor: form.primaryColor }}>
        {form.displayName[0] || <Building2 className="w-8 h-8" />}
      </div>
      <div>
        <h2 className="text-xl font-bold text-white">{form.displayName} onboarded!</h2>
        <p className="text-sm text-white/50 mt-1">
          Config saved in-memory (dev). DB persistence will apply in Phase 2.
        </p>
      </div>
      <div className="flex items-center gap-3 mt-2">
        <Link href="/gifsy/clients"
          className="px-4 py-2 bg-white/10 border border-white/20 text-white text-sm font-medium rounded-lg hover:bg-white/15 transition-colors">
          Back to Clients
        </Link>
        <Link href="/gifsy"
          className="px-4 py-2 bg-[var(--brand-primary)] text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity">
          Platform Overview
        </Link>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared micro-components
// ─────────────────────────────────────────────────────────────────────────────

function StepHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-base font-semibold text-white">{title}</h2>
      <p className="text-sm text-white/50 mt-0.5">{description}</p>
    </div>
  );
}

function Field({ label, hint, children, className = '' }: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="block text-xs font-medium text-white/60 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-xs text-white/30 mt-1">{hint}</p>}
    </div>
  );
}

function Toggle({ enabled }: { enabled: boolean }) {
  return (
    <div className={`relative w-10 h-5 rounded-full shrink-0 transition-colors pointer-events-none ${
      enabled ? 'bg-[var(--brand-primary)]' : 'bg-white/15'
    }`}>
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
        enabled ? 'translate-x-5' : 'translate-x-0.5'
      }`} />
    </div>
  );
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 bg-white/5 border-b border-white/5">
        <p className="text-xs font-semibold text-white/50">{title}</p>
      </div>
      <div className="px-4 py-3 space-y-2">
        {children}
      </div>
    </div>
  );
}

function ReviewRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-white/40">{label}</span>
      <span className={`text-xs text-white/80 ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
    </div>
  );
}
