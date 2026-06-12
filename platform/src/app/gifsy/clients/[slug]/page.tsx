'use client';

import { use, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, CheckCircle, Clock, AlertCircle,
  Pencil, Save, X, ChevronDown, ChevronUp,
  Palette, Shield, Users, Bell, FileText, Wallet, Building2, ShoppingBag,
} from 'lucide-react';
import { CLIENT_REGISTRY } from '@/lib/platform/client-registry';
import { applyFeatureFlagUpdate } from '@/lib/platform/platform-admin';
import type { ClientConfig, FeatureKey } from '@/lib/platform/client-config';
import { OutletTypeConfigSection } from '@/components/admin/outlet-type-config-section';

// ─────────────────────────────────────────────────────────────────────────────
// Feature metadata — label + description for each toggle
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE_META: Record<FeatureKey, { label: string; description: string }> = {
  visibilityInvoiceModule:  { label: 'Invoice Module',       description: 'GST invoice generation and download for partners' },
  kycApprovalFlow:          { label: 'KYC Approval Flow',    description: 'Multi-level KYC verification workflow for outlets' },
  campaignEnrollmentForm:   { label: 'Enrollment Forms',     description: 'Open / mixed campaigns with custom enrollment forms' },
  salesTeamApp:             { label: 'Sales Team App',       description: 'Mobile app and portal access for sales officers' },
  walletModule:             { label: 'Wallet Module',        description: 'Points wallet, redemption & payout capabilities' },
  referralModule:           { label: 'Referral Module',      description: 'Outlet-referral rewards and tracking' },
  selfEnrollmentAllowed:    { label: 'Self-Enrollment',      description: 'Partners can self-accept schemes (no sales team required)' },
  nonKycOutletCampaigns:    { label: 'Non-KYC Campaigns',   description: 'Campaigns can target outlets that have not completed KYC' },
  multiLevelApproval:       { label: 'Multi-Level Approval', description: 'Require two or more approval levels in hierarchy' },
};

const FEATURE_KEYS = Object.keys(FEATURE_META) as FeatureKey[];

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function ClientConfigPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const seedConfig = CLIENT_REGISTRY[slug];

  if (!seedConfig) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <Building2 className="w-10 h-10 text-white/20" />
        <p className="text-white/50 text-sm">Client <code className="font-mono">{slug}</code> not found.</p>
        <Link href="/gifsy/clients" className="text-[var(--brand-primary)] text-sm hover:underline">
          ← Back to Clients
        </Link>
      </div>
    );
  }

  return <ClientConfigEditor initialConfig={seedConfig} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor — full client component
// ─────────────────────────────────────────────────────────────────────────────

function ClientConfigEditor({ initialConfig }: { initialConfig: ClientConfig }) {
  const [config, setConfig] = useState<ClientConfig>(initialConfig);
  const [saved, setSaved]   = useState(false);

  /** Flash a "Saved" indicator briefly */
  const flashSaved = useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }, []);

  /** Toggle a single feature flag using the platform rule (GIFSY_ADMIN only) */
  const toggleFeature = useCallback((key: FeatureKey, value: boolean) => {
    setConfig((prev) => applyFeatureFlagUpdate(prev, key, value, 'GIFSY_ADMIN'));
    flashSaved();
  }, [flashSaved]);

  /** Update the client status */
  const setStatus = useCallback((status: ClientConfig['status']) => {
    setConfig((prev) => ({ ...prev, status }));
    flashSaved();
  }, [flashSaved]);

  return (
    <div className="space-y-6">
      {/* Breadcrumb + header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/gifsy/clients"
            className="inline-flex items-center gap-1 text-xs text-white/40 hover:text-white/70 transition-colors mb-2"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Clients
          </Link>
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold text-white shrink-0"
              style={{ backgroundColor: config.branding.primaryColor }}
            >
              {config.branding.displayName[0]}
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">{config.branding.displayName}</h1>
              <p className="text-sm text-white/40">{config.internalName} · <code className="font-mono text-xs">{config.slug}.loyaltybase.in</code></p>
            </div>
          </div>
        </div>

        {/* Status + saved indicator */}
        <div className="flex items-center gap-2 shrink-0">
          {saved && (
            <span className="flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-3 py-1.5 rounded-lg">
              <CheckCircle className="w-3.5 h-3.5" />
              Saved (memory)
            </span>
          )}
          <StatusSelect status={config.status} onChange={setStatus} />
        </div>
      </div>

      {/* Note banner */}
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3 text-xs text-amber-300">
        <strong>Dev mode:</strong> Changes update in-memory only. DB persistence comes in Platform Phase 2.
      </div>

      {/* Sections */}
      <Section icon={Palette} title="Branding" defaultOpen>
        <BrandingSection config={config} onChange={(b) => { setConfig((p) => ({ ...p, branding: { ...p.branding, ...b } })); flashSaved(); }} />
      </Section>

      <Section icon={Shield} title="Feature Flags" defaultOpen>
        <FeatureFlagsSection config={config} onToggle={toggleFeature} />
      </Section>

      <Section icon={Users} title="Partner Classes">
        <PartnerClassesSection config={config} />
      </Section>

      <Section icon={Building2} title="Approval Hierarchy">
        <HierarchySection config={config} />
      </Section>

      <Section icon={Bell} title="Notifications (MSG91)">
        <NotificationsSection config={config} onChange={(n) => { setConfig((p) => ({ ...p, notifications: { ...p.notifications, ...n } })); flashSaved(); }} />
      </Section>

      <Section icon={FileText} title="Invoicing">
        <InvoicingSection config={config} onChange={(inv) => { setConfig((p) => ({ ...p, invoicing: { ...p.invoicing, ...inv } })); flashSaved(); }} />
      </Section>

      <Section icon={Wallet} title="Wallet Defaults">
        <WalletSection config={config} onChange={(w) => { setConfig((p) => ({ ...p, wallet: { ...p.wallet, ...w } })); flashSaved(); }} />
      </Section>

      <Section icon={ShoppingBag} title="Outlet Type Configuration">
        <OutletTypeConfigSection clientId={config.slug} />
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Collapsible section wrapper
// ─────────────────────────────────────────────────────────────────────────────

function Section({
  icon: Icon, title, children, defaultOpen = false,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Icon className="w-4 h-4 text-white/50" />
          <span className="text-sm font-semibold text-white">{title}</span>
        </div>
        {open
          ? <ChevronUp className="w-4 h-4 text-white/40" />
          : <ChevronDown className="w-4 h-4 text-white/40" />}
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1 border-t border-white/5">
          {children}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Status select
// ─────────────────────────────────────────────────────────────────────────────

function StatusSelect({
  status, onChange,
}: {
  status: ClientConfig['status'];
  onChange: (s: ClientConfig['status']) => void;
}) {
  const Icon = status === 'ACTIVE' ? CheckCircle : status === 'ONBOARDING' ? Clock : AlertCircle;
  const color = status === 'ACTIVE' ? 'text-green-400 bg-green-500/20 border-green-500/30'
    : status === 'ONBOARDING' ? 'text-amber-400 bg-amber-500/20 border-amber-500/30'
    : 'text-red-400 bg-red-500/20 border-red-500/30';

  return (
    <div className="relative">
      <select
        value={status}
        onChange={(e) => onChange(e.target.value as ClientConfig['status'])}
        className={`appearance-none flex items-center gap-1.5 pl-8 pr-6 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${color} bg-transparent focus:outline-none`}
      >
        <option value="ACTIVE">Active</option>
        <option value="ONBOARDING">Onboarding</option>
        <option value="INACTIVE">Inactive</option>
      </select>
      <Icon className={`absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none ${
        status === 'ACTIVE' ? 'text-green-400' : status === 'ONBOARDING' ? 'text-amber-400' : 'text-red-400'
      }`} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Branding section
// ─────────────────────────────────────────────────────────────────────────────

function BrandingSection({
  config, onChange,
}: {
  config: ClientConfig;
  onChange: (partial: Partial<ClientConfig['branding']>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(config.branding);

  const save = () => { onChange(draft); setEditing(false); };
  const cancel = () => { setDraft(config.branding); setEditing(false); };

  if (!editing) {
    return (
      <div className="space-y-4 pt-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl shrink-0" style={{ backgroundColor: config.branding.primaryColor }} />
          <div>
            <p className="text-sm font-semibold text-white">{config.branding.displayName}</p>
            <p className="text-xs text-white/40 font-mono">{config.branding.primaryColor}</p>
          </div>
          <button onClick={() => setEditing(true)} className="ml-auto flex items-center gap-1.5 text-xs text-white/40 hover:text-white transition-colors">
            <Pencil className="w-3.5 h-3.5" />Edit
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <InfoRow label="Support email" value={config.branding.supportEmail} />
          <InfoRow label="Support phone" value={config.branding.supportPhone} />
          <InfoRow label="Brands" value={config.branding.productBrands.join(', ') || '—'} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pt-2">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Display name">
          <input value={draft.displayName} onChange={(e) => setDraft((p) => ({ ...p, displayName: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="Primary colour">
          <div className="flex items-center gap-2">
            <input type="color" value={draft.primaryColor}
              onChange={(e) => setDraft((p) => ({ ...p, primaryColor: e.target.value }))}
              className="w-9 h-9 rounded-lg border border-white/20 bg-transparent cursor-pointer p-0.5" />
            <input value={draft.primaryColor} onChange={(e) => setDraft((p) => ({ ...p, primaryColor: e.target.value }))}
              className={INPUT_CLS + ' flex-1 font-mono'} />
          </div>
        </Field>
        <Field label="Support email">
          <input value={draft.supportEmail} onChange={(e) => setDraft((p) => ({ ...p, supportEmail: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="Support phone">
          <input value={draft.supportPhone} onChange={(e) => setDraft((p) => ({ ...p, supportPhone: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="Product brands (comma-separated)" className="col-span-2">
          <input
            value={draft.productBrands.join(', ')}
            onChange={(e) => setDraft((p) => ({ ...p, productBrands: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }))}
            className={INPUT_CLS}
          />
        </Field>
      </div>
      <EditActions onSave={save} onCancel={cancel} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature flags section
// ─────────────────────────────────────────────────────────────────────────────

function FeatureFlagsSection({
  config, onToggle,
}: {
  config: ClientConfig;
  onToggle: (key: FeatureKey, value: boolean) => void;
}) {
  return (
    <div className="pt-2 space-y-2">
      {FEATURE_KEYS.map((key) => {
        const enabled = !!(config.features as unknown as Record<string, boolean>)[key];
        const meta    = FEATURE_META[key];
        return (
          <div key={key} className="flex items-center gap-4 px-4 py-3 rounded-xl bg-white/5 border border-white/5 hover:border-white/10 transition-colors">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white">{meta.label}</p>
              <p className="text-xs text-white/40 mt-0.5">{meta.description}</p>
            </div>
            <Toggle enabled={enabled} onChange={(v) => onToggle(key, v)} />
          </div>
        );
      })}

      {/* PartnerApp auto-sync note */}
      <p className="text-xs text-white/30 pt-1 px-1">
        Partner app tabs (Invoices, Wallet) sync automatically with Invoice Module and Wallet Module flags.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Partner classes section
// ─────────────────────────────────────────────────────────────────────────────

function PartnerClassesSection({ config }: { config: ClientConfig }) {
  return (
    <div className="pt-2 space-y-2">
      {config.partnerClasses.sort((a, b) => a.order - b.order).map((cls) => (
        <div key={cls.key} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 border border-white/5">
          <div className="w-7 h-7 rounded-lg shrink-0" style={{ backgroundColor: cls.color }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">{cls.displayName}</p>
            <p className="text-xs text-white/40 font-mono">{cls.key} · tier {cls.order}</p>
          </div>
          <span className="text-xs text-white/30 font-mono">{cls.color}</span>
        </div>
      ))}
      <p className="text-xs text-white/30 pt-1 px-1">Partner class editing coming in Phase 2.</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Approval hierarchy section
// ─────────────────────────────────────────────────────────────────────────────

function HierarchySection({ config }: { config: ClientConfig }) {
  const { levels, requireGifsyFinalApproval } = config.approvalHierarchy;

  return (
    <div className="pt-2 space-y-2">
      {levels.map((lvl) => (
        <div key={lvl.roleKey} className="px-4 py-3 rounded-xl bg-white/5 border border-white/5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-bold text-white/60 bg-white/10 px-2 py-0.5 rounded font-mono">{lvl.roleKey}</span>
            <span className="text-sm font-semibold text-white">{lvl.displayName}</span>
            <span className="text-xs text-white/30">({lvl.shortName})</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <FlagChip label="Initiate KYC"    on={lvl.canInitiateKyc} />
            <FlagChip label="Approve KYC"     on={lvl.canApproveKyc} />
            <FlagChip label="View all outlets" on={lvl.canViewAllOutlets} />
          </div>
        </div>
      ))}
      <div className="px-4 py-3 rounded-xl bg-white/5 border border-white/5 flex items-center justify-between">
        <span className="text-sm text-white/70">Gifsy final approval required</span>
        <span className={requireGifsyFinalApproval ? 'text-green-400 text-xs font-medium' : 'text-white/30 text-xs'}>
          {requireGifsyFinalApproval ? 'Yes' : 'No'}
        </span>
      </div>
      <p className="text-xs text-white/30 pt-1 px-1">Hierarchy editing coming in Phase 2.</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications section
// ─────────────────────────────────────────────────────────────────────────────

function NotificationsSection({
  config, onChange,
}: {
  config: ClientConfig;
  onChange: (partial: Partial<ClientConfig['notifications']>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(config.notifications);

  const save   = () => { onChange(draft); setEditing(false); };
  const cancel = () => { setDraft(config.notifications); setEditing(false); };

  if (!editing) {
    return (
      <div className="pt-2 space-y-3">
        <div className="flex items-center justify-between">
          <div className="grid grid-cols-2 gap-3 flex-1 text-xs">
            <InfoRow label="WA Sender ID"  value={config.notifications.whatsappSenderId} />
            <InfoRow label="SMS Sender ID" value={config.notifications.smsSenderId} />
            <InfoRow label="MSG91 Auth Key" value="••••••••••••••••  (server-side only)" />
          </div>
          <button onClick={() => setEditing(true)} className="ml-4 flex items-center gap-1.5 text-xs text-white/40 hover:text-white transition-colors">
            <Pencil className="w-3.5 h-3.5" />Edit
          </button>
        </div>

        <p className="text-xs font-medium text-white/50 pt-1">Template IDs</p>
        <div className="grid grid-cols-2 gap-2">
          {(Object.entries(config.notifications.templateIds) as [string, string][]).map(([k, v]) => (
            <InfoRow key={k} label={camelToLabel(k)} value={v} mono />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="pt-2 space-y-4">
      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-300">
        The MSG91 Auth Key is stored via environment variables server-side and cannot be edited here.
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="WA Sender ID">
          <input value={draft.whatsappSenderId} onChange={(e) => setDraft((p) => ({ ...p, whatsappSenderId: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="SMS Sender ID">
          <input value={draft.smsSenderId} onChange={(e) => setDraft((p) => ({ ...p, smsSenderId: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
      </div>

      <p className="text-xs font-medium text-white/50">Template IDs</p>
      <div className="grid grid-cols-2 gap-3">
        {(Object.keys(config.notifications.templateIds) as (keyof typeof config.notifications.templateIds)[]).map((k) => (
          <Field key={k} label={camelToLabel(k)}>
            <input
              value={draft.templateIds[k]}
              onChange={(e) => setDraft((p) => ({ ...p, templateIds: { ...p.templateIds, [k]: e.target.value } }))}
              className={INPUT_CLS + ' font-mono text-xs'}
            />
          </Field>
        ))}
      </div>
      <EditActions onSave={save} onCancel={cancel} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoicing section
// ─────────────────────────────────────────────────────────────────────────────

function InvoicingSection({
  config, onChange,
}: {
  config: ClientConfig;
  onChange: (partial: Partial<ClientConfig['invoicing']>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(config.invoicing);

  const save   = () => { onChange(draft); setEditing(false); };
  const cancel = () => { setDraft(config.invoicing); setEditing(false); };

  if (!editing) {
    return (
      <div className="pt-2 space-y-3">
        <div className="flex items-center justify-between">
          <div className="grid grid-cols-2 gap-3 flex-1 text-xs">
            <InfoRow label="Seller legal name" value={config.invoicing.sellerLegalName} />
            <InfoRow label="GSTIN"             value={config.invoicing.sellerGstin} mono />
            <InfoRow label="State"             value={config.invoicing.sellerState} />
            <InfoRow label="PAN"               value={config.invoicing.sellerPan} mono />
            <InfoRow label="Invoice prefix"    value={config.invoicing.invoicePrefix} mono />
            <InfoRow label="SAC code"          value={config.invoicing.sacCode} mono />
            <InfoRow label="Bank name"         value={config.invoicing.bankName} />
            <InfoRow label="Bank IFSC"         value={config.invoicing.bankIfsc} mono />
          </div>
          <button onClick={() => setEditing(true)} className="ml-4 flex items-center gap-1.5 text-xs text-white/40 hover:text-white transition-colors">
            <Pencil className="w-3.5 h-3.5" />Edit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-2 space-y-4">
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2 text-xs text-blue-300">
        Seller legal name is always <strong>Tech Gifsy Solutions Limited</strong> and cannot be changed.
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="GSTIN">
          <input value={draft.sellerGstin} onChange={(e) => setDraft((p) => ({ ...p, sellerGstin: e.target.value }))}
            className={INPUT_CLS + ' font-mono'} />
        </Field>
        <Field label="Seller state">
          <input value={draft.sellerState} onChange={(e) => setDraft((p) => ({ ...p, sellerState: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="Invoice prefix">
          <input value={draft.invoicePrefix} onChange={(e) => setDraft((p) => ({ ...p, invoicePrefix: e.target.value }))}
            className={INPUT_CLS + ' font-mono'} />
        </Field>
        <Field label="SAC code">
          <input value={draft.sacCode} onChange={(e) => setDraft((p) => ({ ...p, sacCode: e.target.value }))}
            className={INPUT_CLS + ' font-mono'} />
        </Field>
        <Field label="Bank name">
          <input value={draft.bankName} onChange={(e) => setDraft((p) => ({ ...p, bankName: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="Bank IFSC">
          <input value={draft.bankIfsc} onChange={(e) => setDraft((p) => ({ ...p, bankIfsc: e.target.value }))}
            className={INPUT_CLS + ' font-mono'} />
        </Field>
        <Field label="Bank branch" className="col-span-2">
          <input value={draft.bankBranch} onChange={(e) => setDraft((p) => ({ ...p, bankBranch: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="Seller address" className="col-span-2">
          <input value={draft.sellerAddress} onChange={(e) => setDraft((p) => ({ ...p, sellerAddress: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
      </div>
      <EditActions onSave={save} onCancel={cancel} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet section
// ─────────────────────────────────────────────────────────────────────────────

function WalletSection({
  config, onChange,
}: {
  config: ClientConfig;
  onChange: (partial: Partial<ClientConfig['wallet']>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(config.wallet);

  const save   = () => { onChange(draft); setEditing(false); };
  const cancel = () => { setDraft(config.wallet); setEditing(false); };

  if (!editing) {
    return (
      <div className="pt-2">
        <div className="flex items-center justify-between">
          <div className="grid grid-cols-2 gap-3 flex-1 text-xs">
            <InfoRow label="Holding period" value={`${config.wallet.defaultHoldingPeriodDays} days`} />
            <InfoRow label="Points expiry"  value={config.wallet.pointsExpiryDays ? `${config.wallet.pointsExpiryDays} days` : 'Never'} />
            <InfoRow label="Min redemption" value={`₹${config.wallet.minRedemptionAmount}`} />
            <InfoRow label="Points → ₹"    value={`1 pt = ₹${config.wallet.pointsToRupeeRatio}`} />
            <InfoRow label="Redemption modes" value={config.wallet.redemptionModes.join(', ')} />
          </div>
          <button onClick={() => setEditing(true)} className="ml-4 flex items-center gap-1.5 text-xs text-white/40 hover:text-white transition-colors">
            <Pencil className="w-3.5 h-3.5" />Edit
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pt-2 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Holding period (days)">
          <input type="number" value={draft.defaultHoldingPeriodDays}
            onChange={(e) => setDraft((p) => ({ ...p, defaultHoldingPeriodDays: Number(e.target.value) }))}
            className={INPUT_CLS} min={0} />
        </Field>
        <Field label="Points expiry (days, blank = never)">
          <input type="number" value={draft.pointsExpiryDays ?? ''}
            onChange={(e) => setDraft((p) => ({ ...p, pointsExpiryDays: e.target.value ? Number(e.target.value) : null }))}
            className={INPUT_CLS} min={0} placeholder="Never" />
        </Field>
        <Field label="Min redemption amount (₹)">
          <input type="number" value={draft.minRedemptionAmount}
            onChange={(e) => setDraft((p) => ({ ...p, minRedemptionAmount: Number(e.target.value) }))}
            className={INPUT_CLS} min={0} />
        </Field>
        <Field label="Points to ₹ ratio">
          <input type="number" value={draft.pointsToRupeeRatio} step="0.01"
            onChange={(e) => setDraft((p) => ({ ...p, pointsToRupeeRatio: Number(e.target.value) }))}
            className={INPUT_CLS} min={0} />
        </Field>
        <Field label="Redemption modes" className="col-span-2">
          <div className="flex flex-wrap gap-2 pt-1">
            {(['UPI', 'NEFT', 'RTGS', 'IMPS'] as const).map((mode) => {
              const on = draft.redemptionModes.includes(mode);
              return (
                <button key={mode} type="button"
                  onClick={() => setDraft((p) => ({
                    ...p,
                    redemptionModes: on
                      ? p.redemptionModes.filter((m) => m !== mode)
                      : [...p.redemptionModes, mode],
                  }))}
                  className={`px-3 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    on ? 'bg-[var(--brand-primary)]/20 border-[var(--brand-primary)]/50 text-white' : 'bg-white/5 border-white/10 text-white/40'
                  }`}
                >
                  {mode}
                </button>
              );
            })}
          </div>
        </Field>
      </div>
      <EditActions onSave={save} onCancel={cancel} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared micro-components
// ─────────────────────────────────────────────────────────────────────────────

const INPUT_CLS =
  'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/30';

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <label className="block text-xs text-white/50 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-white/40 text-xs mb-0.5">{label}</p>
      <p className={`text-white/80 text-xs ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={() => onChange(!enabled)}
      className={`relative w-10 h-5 rounded-full shrink-0 transition-colors ${
        enabled ? 'bg-[var(--brand-primary)]' : 'bg-white/15'
      }`}
    >
      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
        enabled ? 'translate-x-5' : 'translate-x-0.5'
      }`} />
    </button>
  );
}

function FlagChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${
      on
        ? 'bg-green-500/15 border-green-500/30 text-green-400'
        : 'bg-white/5 border-white/10 text-white/30'
    }`}>
      {on ? <CheckCircle className="w-3 h-3" /> : <X className="w-3 h-3" />}
      {label}
    </span>
  );
}

function EditActions({ onSave, onCancel }: { onSave: () => void; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      <button onClick={onSave}
        className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity">
        <Save className="w-3.5 h-3.5" />Save
      </button>
      <button onClick={onCancel}
        className="flex items-center gap-1.5 px-3 py-2 bg-white/5 border border-white/10 text-white/60 text-xs font-medium rounded-lg hover:text-white transition-colors">
        <X className="w-3.5 h-3.5" />Cancel
      </button>
    </div>
  );
}

function camelToLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase());
}
