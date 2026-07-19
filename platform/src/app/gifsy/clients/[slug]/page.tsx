'use client';

import { use, useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, CheckCircle, Clock, AlertCircle,
  Pencil, Save, X, ChevronDown, ChevronUp,
  Palette, Shield, Users, Bell, FileText, Wallet, Building2, ShoppingBag, Loader2,
  Settings, Power, Globe, Plus, Trash2, Star, Image as ImageIcon, Upload,
} from 'lucide-react';
import { applyFeatureFlagUpdate, validateTenantDomain, normalizeTenantDomain, TENANT_DOMAIN_SUFFIX } from '@/lib/platform/platform-admin';
import type { ClientConfig, FeatureKey } from '@/lib/platform/client-config';
import { OutletTypeConfigSection } from '@/components/admin/outlet-type-config-section';
import { getToken } from '@/lib/auth-client';

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
  rbacEnforcement:          { label: 'RBAC Enforcement',     description: 'Enforce permission checks on admin routes for this tenant (requires RBAC_ENFORCEMENT env=true)' },
};

const FEATURE_KEYS = Object.keys(FEATURE_META) as FeatureKey[];

// ─────────────────────────────────────────────────────────────────────────────
// Branding assets — the 4 upload slots and which branding-blob URL each fills.
// `kind` is the multipart field the backend expects; the mapped field is where
// the returned URL lands in BrandingConfig (and drives the preview).
// ─────────────────────────────────────────────────────────────────────────────

type BrandingAssetKind = 'logo' | 'wordmarkWhite' | 'wordmarkColor' | 'favicon';

/** The branding-blob URL fields the asset uploads write to (all string-valued). */
type BrandingAssetField = 'logoUrl' | 'wordmarkWhiteUrl' | 'wordmarkColorUrl' | 'faviconUrl';

const BRANDING_ASSET_FIELD: Record<BrandingAssetKind, BrandingAssetField> = {
  logo:          'logoUrl',
  wordmarkWhite: 'wordmarkWhiteUrl',
  wordmarkColor: 'wordmarkColorUrl',
  favicon:       'faviconUrl',
};

const BRANDING_ASSET_META: { kind: BrandingAssetKind; label: string; hint: string; dark?: boolean }[] = [
  { kind: 'logo',          label: 'Logo',            hint: 'Square mark — app icon / hexagon slot' },
  { kind: 'wordmarkWhite', label: 'Wordmark (white)', hint: 'For DARK surfaces (sales navy header, sidebar)', dark: true },
  { kind: 'wordmarkColor', label: 'Wordmark (colour)', hint: 'For LIGHT surfaces (white partner header)' },
  { kind: 'favicon',       label: 'Favicon',         hint: 'Browser-tab icon' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

// B3 (#49): the per-client detail now reads the REAL `clients` table via
// GET /api/gifsy/clients/:slug (was the static lib/platform/client-registry mock).
// The backend omits msg91AuthKey (never sent to the browser); the editor never
// reads it, so we fill a server-side-only placeholder to satisfy the type.
type ClientDetail = Omit<ClientConfig, 'notifications'> & {
  notifications: Omit<ClientConfig['notifications'], 'msg91AuthKey'>;
};

export default function ClientConfigPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/gifsy/clients/${slug}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then(async (r) => {
        if (r.status === 404) { if (!cancelled) setNotFound(true); return null; }
        const j = await r.json();
        if (!j.success) throw new Error(j.error || 'Failed to load client');
        return j.data as ClientDetail;
      })
      .then((detail) => {
        if (cancelled || !detail) return;
        setConfig({
          ...detail,
          notifications: { ...detail.notifications, msg91AuthKey: '••• (server-side only)' },
        } as ClientConfig);
      })
      .catch(() => { if (!cancelled) setError('Could not load client'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3 text-white/40 text-sm">
        <Loader2 className="w-6 h-6 animate-spin" />
        Loading client…
      </div>
    );
  }

  if (notFound || error || !config) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <Building2 className="w-10 h-10 text-white/20" />
        <p className="text-white/50 text-sm">
          {notFound
            ? <>Client <code className="font-mono">{slug}</code> not found.</>
            : (error ?? 'Could not load client.')}
        </p>
        <Link href="/gifsy/clients" className="text-[var(--brand-primary)] text-sm hover:underline">
          ← Back to Clients
        </Link>
      </div>
    );
  }

  return <ClientConfigEditor initialConfig={config} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor — full client component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The subset of fields the real PATCH /api/gifsy/clients/:slug endpoint accepts.
 * Any subset may be sent; only the edited fields are included in a save.
 */
interface ClientPatchBody {
  status?: ClientConfig['status'];
  internalName?: string;
  displayName?: string;
  primaryColor?: string;
  supportEmail?: string;
  supportPhone?: string;
  invoicePrefix?: string;
}

/** Shape returned by the PATCH endpoint (subset we merge back into local config).
 *  The service returns a FLAT projection (displayName/primaryColor/... at the top level,
 *  NOT nested under `branding`) — matching createClient/listClients. */
interface ClientPatchResponse {
  id: string;
  internalName: string;
  status: ClientConfig['status'];
  displayName?: string;
  primaryColor?: string;
  supportEmail?: string;
  supportPhone?: string;
  invoicePrefix?: string;
  features?: Record<string, boolean>;
}

function ClientConfigEditor({ initialConfig }: { initialConfig: ClientConfig }) {
  const [config, setConfig] = useState<ClientConfig>(initialConfig);
  const [saved, setSaved]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Flash a "Saved" indicator briefly (used by the in-memory-only sections) */
  const flashSaved = useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }, []);

  /**
   * REAL persistence: PATCH /api/gifsy/clients/:slug (proxied to the backend
   * /v1/gifsy/clients/:slug, GIFSY_ADMIN). Sends only the passed (changed) fields,
   * then merges the returned client back into local state. Unlike the in-memory
   * sections below, this is durable.
   */
  const saveClient = useCallback(async (patch: ClientPatchBody): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/gifsy/clients/${config.slug}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken() ?? ''}`,
        },
        body: JSON.stringify(patch),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) {
        throw new Error(j?.error || 'Save failed');
      }
      const updated = j.data as ClientPatchResponse;
      // Merge the authoritative server response back into local state. The response is
      // FLAT (updated.displayName, not updated.branding.displayName) — reading it nested
      // made every branding/invoicing edit fall back to the OLD value + visually revert
      // after "Saved". Fall back to the submitted `patch` when the server omits a field.
      setConfig((prev) => ({
        ...prev,
        internalName: updated.internalName ?? prev.internalName,
        status: updated.status ?? prev.status,
        branding: {
          ...prev.branding,
          displayName:  updated.displayName  ?? patch.displayName  ?? prev.branding.displayName,
          primaryColor: updated.primaryColor ?? patch.primaryColor ?? prev.branding.primaryColor,
          supportEmail: updated.supportEmail ?? patch.supportEmail ?? prev.branding.supportEmail,
          supportPhone: updated.supportPhone ?? patch.supportPhone ?? prev.branding.supportPhone,
        },
        invoicing: {
          ...prev.invoicing,
          invoicePrefix: updated.invoicePrefix ?? patch.invoicePrefix ?? prev.invoicing.invoicePrefix,
        },
      }));
      flashSaved();
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
      return false;
    } finally {
      setSaving(false);
    }
  }, [config.slug, flashSaved]);

  /**
   * REAL persistence for the tenant's custom-domain set. The backend RECONCILES
   * the stored set to the supplied one (canonical `<slug>.gifsy.in` is always kept)
   * and re-derives the primary. The PATCH projection does NOT echo domains, so we
   * refetch the detail afterwards to read the authoritative primary-first ordering.
   * Returns a 409 conflict message (domain already assigned to another tenant)
   * cleanly for the caller to surface.
   */
  const saveDomains = useCallback(async (domains: string[]): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/gifsy/clients/${config.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` },
        body: JSON.stringify({ domains }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) {
        // 409 domain clash surfaces here as { success:false, error:'Domain … already assigned …' }
        return { ok: false, error: j?.error || j?.message || `Save failed (HTTP ${res.status})` };
      }
      // Refetch the detail to get the canonical primary-first domain ordering.
      const detailRes = await fetch(`/api/gifsy/clients/${config.slug}`, {
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      });
      const detailJson = await detailRes.json().catch(() => null);
      const nextDomains: string[] | undefined = detailJson?.success ? detailJson.data?.domains : undefined;
      // On refetch success use the authoritative primary-first set; if the refetch
      // FAILED, keep the prior (server-derived) domains rather than the sent list —
      // the sent list omits the backend-appended canonical and isn't primary-first,
      // so it would transiently look unroutable. Self-heals on the next full load.
      setConfig((prev) => ({ ...prev, domains: nextDomains ?? prev.domains }));
      flashSaved();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error — please try again.' };
    }
  }, [config.slug, flashSaved]);

  /**
   * REAL persistence for notifications (sender IDs + WhatsApp/SMS template names).
   * Deep-merged server-side into the notifications blob; msg91AuthKey is untouched
   * (it is never sent to the browser and never written here).
   */
  const saveNotifications = useCallback(async (
    n: Pick<ClientConfig['notifications'], 'whatsappSenderId' | 'smsSenderId' | 'templateIds'>,
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch(`/api/gifsy/clients/${config.slug}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}` },
        body: JSON.stringify({ notifications: n }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) {
        return { ok: false, error: j?.error || j?.message || `Save failed (HTTP ${res.status})` };
      }
      setConfig((prev) => ({ ...prev, notifications: { ...prev.notifications, ...n } }));
      flashSaved();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Network error — please try again.' };
    }
  }, [config.slug, flashSaved]);

  /**
   * REAL upload of a branding image (logo / white wordmark / colour wordmark /
   * favicon). Multipart to the branding-asset endpoint (which sniffs magic bytes,
   * caps at 5 MB, and persists the returned URL onto the branding blob), then the
   * returned URL is merged into local state to drive the preview.
   */
  const uploadAsset = useCallback(async (
    kind: BrandingAssetKind,
    file: File,
  ): Promise<{ ok: boolean; url?: string; error?: string }> => {
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', kind);
      const res = await fetch(`/api/gifsy/clients/${config.slug}/branding-asset`, {
        method: 'POST',
        // Do NOT set Content-Type — the browser sets the multipart boundary.
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
        body: fd,
      });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success || !j.data?.url) {
        return { ok: false, error: j?.error || j?.message || `Upload failed (HTTP ${res.status})` };
      }
      const url = j.data.url as string;
      const field = BRANDING_ASSET_FIELD[kind];
      setConfig((prev) => ({ ...prev, branding: { ...prev.branding, [field]: url } }));
      flashSaved();
      return { ok: true, url };
    } catch {
      return { ok: false, error: 'Network error — please try again.' };
    }
  }, [config.slug, flashSaved]);

  /** Toggle a single feature flag using the platform rule (GIFSY_ADMIN only) */
  const toggleFeature = useCallback((key: FeatureKey, value: boolean) => {
    setConfig((prev) => applyFeatureFlagUpdate(prev, key, value, 'GIFSY_ADMIN'));
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
              <p className="text-sm text-white/40">{config.internalName} · <code className="font-mono text-xs">{config.slug}.gifsy.in</code></p>
            </div>
          </div>
        </div>

        {/* Status pill + saved indicator */}
        <div className="flex items-center gap-2 shrink-0">
          {saved && (
            <span className="flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-3 py-1.5 rounded-lg">
              <CheckCircle className="w-3.5 h-3.5" />
              Saved
            </span>
          )}
          <StatusPill status={config.status} />
        </div>
      </div>

      {/* REAL client-settings editor (status + branding/invoicing → PATCH) */}
      <Section icon={Settings} title="Client settings" defaultOpen>
        <ClientSettingsSection
          config={config}
          saving={saving}
          error={saveError}
          onSave={saveClient}
        />
      </Section>

      {/* Custom domains (§A-DOMAIN) — REAL persistence via PATCH { domains } */}
      <Section icon={Globe} title="Domains" defaultOpen>
        <DomainsSection config={config} onSave={saveDomains} />
      </Section>

      {/* Brand assets — REAL uploads via the branding-asset endpoint */}
      <Section icon={ImageIcon} title="Brand Assets">
        <BrandAssetsSection config={config} onUpload={uploadAsset} />
      </Section>

      {/* Sections */}
      <Section icon={Palette} title="Branding" defaultOpen>
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-300 mb-3">
          <strong>Dev mode:</strong> this card updates in-memory only. Persist display name, colour &amp; support details in <strong>Client settings</strong> (top); upload logo/wordmark/favicon in <strong>Brand Assets</strong>.
        </div>
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
        <NotificationsSection config={config} onSave={saveNotifications} />
      </Section>

      <Section icon={FileText} title="Invoicing">
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-300 mb-3">
          <strong>Dev mode:</strong> this card updates in-memory only. The invoice prefix persists via <strong>Client settings</strong> (top).
        </div>
        <InvoicingSection config={config} onChange={(inv) => { setConfig((p) => ({ ...p, invoicing: { ...p.invoicing, ...inv } })); flashSaved(); }} />
      </Section>

      <Section icon={Wallet} title="Wallet Defaults">
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 text-xs text-amber-300 mb-3">
          <strong>Dev mode:</strong> Wallet defaults update in-memory only. DB persistence comes in Platform Phase 2.
        </div>
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
// Status pill (read-only header badge; the editable control lives in Client settings)
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<ClientConfig['status'], string> = {
  ACTIVE: 'Active', ONBOARDING: 'Onboarding', INACTIVE: 'Inactive',
};

function StatusPill({ status }: { status: ClientConfig['status'] }) {
  const Icon = status === 'ACTIVE' ? CheckCircle : status === 'ONBOARDING' ? Clock : AlertCircle;
  const color = status === 'ACTIVE' ? 'text-green-400 bg-green-500/20 border-green-500/30'
    : status === 'ONBOARDING' ? 'text-amber-400 bg-amber-500/20 border-amber-500/30'
    : 'text-red-400 bg-red-500/20 border-red-500/30';

  return (
    <span
      data-testid="client-status-pill"
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border ${color}`}
    >
      <Icon className="w-3.5 h-3.5" />
      {STATUS_LABEL[status]}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Client settings section — REAL persistence (status + core branding) via PATCH
// ─────────────────────────────────────────────────────────────────────────────

function ClientSettingsSection({
  config, saving, error, onSave,
}: {
  config: ClientConfig;
  saving: boolean;
  error: string | null;
  onSave: (patch: ClientPatchBody) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Required<ClientPatchBody>>({
    status:        config.status,
    internalName:  config.internalName,
    displayName:   config.branding.displayName,
    primaryColor:  config.branding.primaryColor,
    supportEmail:  config.branding.supportEmail,
    supportPhone:  config.branding.supportPhone,
    invoicePrefix: config.invoicing.invoicePrefix,
  });

  // Keep the draft in sync when the config changes underneath us (e.g. after a save
  // merges the server response, or the one-click Activate flips the status).
  useEffect(() => {
    setDraft({
      status:        config.status,
      internalName:  config.internalName,
      displayName:   config.branding.displayName,
      primaryColor:  config.branding.primaryColor,
      supportEmail:  config.branding.supportEmail,
      supportPhone:  config.branding.supportPhone,
      invoicePrefix: config.invoicing.invoicePrefix,
    });
  }, [config]);

  /** Only the fields that actually changed from the current saved config. */
  const buildChangedPatch = (): ClientPatchBody => {
    const patch: ClientPatchBody = {};
    if (draft.status        !== config.status)                 patch.status        = draft.status;
    if (draft.internalName  !== config.internalName)           patch.internalName  = draft.internalName;
    if (draft.displayName   !== config.branding.displayName)   patch.displayName   = draft.displayName;
    if (draft.primaryColor  !== config.branding.primaryColor)  patch.primaryColor  = draft.primaryColor;
    if (draft.supportEmail  !== config.branding.supportEmail)  patch.supportEmail  = draft.supportEmail;
    if (draft.supportPhone  !== config.branding.supportPhone)  patch.supportPhone  = draft.supportPhone;
    if (draft.invoicePrefix !== config.invoicing.invoicePrefix) patch.invoicePrefix = draft.invoicePrefix;
    return patch;
  };

  const dirty = Object.keys(buildChangedPatch()).length > 0;

  return (
    <div className="space-y-4 pt-2">
      {/* One-click Activate — removes the ONBOARDING dead-end */}
      {config.status === 'ONBOARDING' && (
        <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-3">
          <Clock className="w-4 h-4 text-amber-400 shrink-0" />
          <p className="text-xs text-amber-200 flex-1">
            This client is still onboarding and is not live for its users yet.
          </p>
          <button
            data-testid="activate-client"
            disabled={saving}
            onClick={() => onSave({ status: 'ACTIVE' })}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-500 text-white text-xs font-semibold rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 shrink-0"
          >
            <Power className="w-3.5 h-3.5" />
            Activate
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <select
            data-testid="status-select"
            value={draft.status}
            onChange={(e) => setDraft((p) => ({ ...p, status: e.target.value as ClientConfig['status'] }))}
            className={INPUT_CLS + ' cursor-pointer'}
          >
            <option value="ONBOARDING">Onboarding</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </Field>
        <Field label="Internal name">
          <input data-testid="internal-name-input" value={draft.internalName}
            onChange={(e) => setDraft((p) => ({ ...p, internalName: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="Display name">
          <input data-testid="display-name-input" value={draft.displayName}
            onChange={(e) => setDraft((p) => ({ ...p, displayName: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="Primary colour">
          <div className="flex items-center gap-2">
            <input type="color" value={draft.primaryColor}
              onChange={(e) => setDraft((p) => ({ ...p, primaryColor: e.target.value }))}
              className="w-9 h-9 rounded-lg border border-white/20 bg-transparent cursor-pointer p-0.5" />
            <input value={draft.primaryColor}
              onChange={(e) => setDraft((p) => ({ ...p, primaryColor: e.target.value }))}
              className={INPUT_CLS + ' flex-1 font-mono'} />
          </div>
        </Field>
        <Field label="Support email">
          <input data-testid="support-email-input" value={draft.supportEmail}
            onChange={(e) => setDraft((p) => ({ ...p, supportEmail: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="Support phone">
          <input data-testid="support-phone-input" value={draft.supportPhone}
            onChange={(e) => setDraft((p) => ({ ...p, supportPhone: e.target.value }))}
            className={INPUT_CLS} />
        </Field>
        <Field label="Invoice prefix">
          <input data-testid="invoice-prefix-input" value={draft.invoicePrefix}
            onChange={(e) => setDraft((p) => ({ ...p, invoicePrefix: e.target.value }))}
            className={INPUT_CLS + ' font-mono'} />
        </Field>
      </div>

      {error && (
        <p data-testid="client-save-error" className="text-xs text-red-400">{error}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          data-testid="client-settings-save"
          disabled={saving || !dirty}
          onClick={() => onSave(buildChangedPatch())}
          className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save changes
        </button>
        {!dirty && <span className="text-xs text-white/30">No unsaved changes</span>}
      </div>
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
// Domains section — REAL persistence via PATCH { domains } (§A-DOMAIN)
// ─────────────────────────────────────────────────────────────────────────────

function DomainsSection({
  config, onSave,
}: {
  config: ClientConfig;
  onSave: (domains: string[]) => Promise<{ ok: boolean; error?: string }>;
}) {
  const canonical = `${config.slug}${TENANT_DOMAIN_SUFFIX}`;
  const saved = config.domains ?? [];
  const [list, setList]         = useState<string[]>(saved);
  const [newDomain, setNewDomain] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [saving, setSaving]     = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-sync when the authoritative (primary-first) set arrives after a save.
  useEffect(() => { setList(config.domains ?? []); }, [config.domains]);

  // The saved primary is the first entry of the primary-first ordering.
  const primary = saved[0];

  const add = () => {
    const err = validateTenantDomain(newDomain);
    if (err) { setAddError(err); return; }
    const d = normalizeTenantDomain(newDomain);
    if (list.some((x) => x.toLowerCase() === d)) { setAddError('Domain is already in the list.'); return; }
    setList((p) => [...p, d]);
    setNewDomain('');
    setAddError(null);
  };

  const remove = (d: string) => {
    if (d.toLowerCase() === canonical.toLowerCase()) return; // canonical is not removable
    setList((p) => p.filter((x) => x !== d));
  };

  const sameSet = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const sa = new Set(a.map((x) => x.toLowerCase()));
    return b.every((x) => sa.has(x.toLowerCase()));
  };
  const dirty = !sameSet(list, saved);

  const save = async () => {
    setSaving(true); setSaveError(null);
    const res = await onSave(list);
    setSaving(false);
    if (!res.ok) setSaveError(res.error ?? 'Save failed');
  };

  return (
    <div className="pt-2 space-y-3">
      <div className="space-y-2">
        {list.length === 0 && (
          <p className="text-xs text-white/40">
            No domains yet — the canonical <code className="font-mono">{canonical}</code> is provisioned on save.
          </p>
        )}
        {list.map((d) => {
          const isCanonical = d.toLowerCase() === canonical.toLowerCase();
          const isPrimary   = !!primary && d.toLowerCase() === primary.toLowerCase();
          return (
            <div key={d} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-white/5 border border-white/5">
              <Globe className="w-4 h-4 text-white/40 shrink-0" />
              <span className="text-sm font-mono text-white/80 flex-1 min-w-0 truncate">{d}</span>
              {isPrimary && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-green-500/15 border border-green-500/30 text-green-400">
                  <Star className="w-3 h-3" />Primary
                </span>
              )}
              {isCanonical && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-white/10 border border-white/10 text-white/40">Default</span>
              )}
              {!isCanonical && (
                <button onClick={() => remove(d)} className="text-white/30 hover:text-red-400 transition-colors" aria-label={`Remove ${d}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Add a branded domain */}
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <input
            value={newDomain}
            onChange={(e) => { setNewDomain(e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, '')); setAddError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder="brand.gifsy.in"
            className={INPUT_CLS + ' font-mono'}
          />
          {addError && (
            <p className="flex items-center gap-1 text-xs text-red-400 mt-1">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />{addError}
            </p>
          )}
        </div>
        <button onClick={add}
          className="flex items-center gap-1.5 px-3 py-2 bg-white/5 border border-white/10 text-white/70 text-xs font-medium rounded-lg hover:text-white transition-colors shrink-0">
          <Plus className="w-3.5 h-3.5" />Add
        </button>
      </div>

      <p className="text-xs text-white/30">
        Each domain must be a <code className="font-mono">*.gifsy.in</code> subdomain (non-reserved first label) and
        unique across all tenants. The canonical <code className="font-mono">{canonical}</code> is always kept; the
        first branded domain becomes the primary.
      </p>

      {saveError && (
        <p className="flex items-center gap-1 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />{saveError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <button onClick={save} disabled={saving || !dirty}
          className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save domains
        </button>
        {!dirty && <span className="text-xs text-white/30">No unsaved changes</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Brand assets section — REAL uploads via POST clients/:slug/branding-asset
// ─────────────────────────────────────────────────────────────────────────────

function BrandAssetsSection({
  config, onUpload,
}: {
  config: ClientConfig;
  onUpload: (kind: BrandingAssetKind, file: File) => Promise<{ ok: boolean; url?: string; error?: string }>;
}) {
  return (
    <div className="pt-2 grid grid-cols-2 gap-3">
      {BRANDING_ASSET_META.map((slot) => (
        <AssetSlot
          key={slot.kind}
          meta={slot}
          url={(config.branding[BRANDING_ASSET_FIELD[slot.kind]] as string | undefined) ?? ''}
          onUpload={(file) => onUpload(slot.kind, file)}
        />
      ))}
    </div>
  );
}

function AssetSlot({
  meta, url, onUpload,
}: {
  meta: { kind: BrandingAssetKind; label: string; hint: string; dark?: boolean };
  url: string;
  onUpload: (file: File) => Promise<{ ok: boolean; url?: string; error?: string }>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading]       = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [previewError, setPreviewError] = useState(false);

  // A fresh URL might now load — reset the "broken image" state when it changes.
  useEffect(() => { setPreviewError(false); }, [url]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same file be re-selected after an error
    if (!file) return;
    setUploading(true); setError(null); setPreviewError(false);
    const res = await onUpload(file);
    setUploading(false);
    if (!res.ok) setError(res.error ?? 'Upload failed');
  };

  return (
    <div className="rounded-xl border border-white/10 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-white">{meta.label}</p>
        {url && !previewError && !error && <CheckCircle className="w-3.5 h-3.5 text-green-400" />}
      </div>

      {/* Preview — dark slot for the white wordmark so it's visible */}
      <div className={`h-20 rounded-lg flex items-center justify-center overflow-hidden border border-white/5 ${meta.dark ? 'bg-slate-900' : 'bg-white/5'}`}>
        {url && !previewError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={meta.label} className="max-h-full max-w-full object-contain" onError={() => setPreviewError(true)} />
        ) : url && previewError ? (
          <div className="text-center px-2">
            <ImageIcon className="w-5 h-5 text-amber-400 mx-auto" />
            <p className="text-[10px] text-amber-300 mt-1 leading-tight">Preview unavailable — URL saved</p>
          </div>
        ) : (
          <ImageIcon className="w-5 h-5 text-white/20" />
        )}
      </div>

      <p className="text-xs text-white/30">{meta.hint}</p>
      {url && <p className="text-[10px] text-white/30 font-mono truncate" title={url}>{url}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={onFile}
      />
      <button onClick={() => inputRef.current?.click()} disabled={uploading}
        className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white/5 border border-white/10 text-white/70 text-xs font-medium rounded-lg hover:text-white transition-colors disabled:opacity-50">
        {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
        {url ? 'Replace' : 'Upload'}
      </button>
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
  config, onSave,
}: {
  config: ClientConfig;
  onSave: (n: Pick<ClientConfig['notifications'], 'whatsappSenderId' | 'smsSenderId' | 'templateIds'>) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(config.notifications);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // Re-sync the draft when the config changes underneath us (after a save merges).
  useEffect(() => { setDraft(config.notifications); }, [config.notifications]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const res = await onSave({
      whatsappSenderId: draft.whatsappSenderId,
      smsSenderId:      draft.smsSenderId,
      templateIds:      draft.templateIds,
    });
    setSaving(false);
    if (res.ok) setEditing(false);
    else setError(res.error ?? 'Save failed');
  };
  const cancel = () => { setDraft(config.notifications); setError(null); setEditing(false); };

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

      <p className="text-xs font-medium text-white/50">Template IDs / names</p>
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
      {error && <p className="text-xs text-red-400">{error}</p>}
      <EditActions onSave={save} onCancel={cancel} saving={saving} />
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

function EditActions({ onSave, onCancel, saving = false }: { onSave: () => void; onCancel: () => void; saving?: boolean }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      <button onClick={onSave} disabled={saving}
        className="flex items-center gap-1.5 px-3 py-2 bg-[var(--brand-primary)] text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50">
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}Save
      </button>
      <button onClick={onCancel} disabled={saving}
        className="flex items-center gap-1.5 px-3 py-2 bg-white/5 border border-white/10 text-white/60 text-xs font-medium rounded-lg hover:text-white transition-colors disabled:opacity-50">
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
