'use client';

import { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Settings2, Loader2, AlertCircle } from 'lucide-react';
import {
  MASTER_OUTLET_TYPES,
  getOutletTypeClientConfig,
  applyOutletTypeClientConfigUpdate,
  type OutletType,
  type OutletTypeClientConfig,
  type OutletTypeFeatureFlag,
} from '@/lib/platform/outlet-types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  clientId: string;
  initialConfigs?: OutletTypeClientConfig[];
}

// ── Feature flag metadata ──────────────────────────────────────────────────────

const FLAG_META: { flag: OutletTypeFeatureFlag; label: string; description: string }[] = [
  { flag: 'loyaltyEnabled',     label: 'Loyalty',              description: 'Earn and redeem points' },
  { flag: 'schemesEnabled',     label: 'Schemes',              description: 'Eligible for scheme enrolment' },
  { flag: 'visibilityEnabled',  label: 'Visibility',           description: 'Submit visibility program photos' },
  { flag: 'payoutsEnabled',     label: 'Payouts',              description: 'Receive UPI / bank payouts' },
  { flag: 'leaderboardEnabled', label: 'Leaderboard',          description: 'Appear in leaderboard rankings' },
  { flag: 'targetsEnabled',     label: 'Targets',              description: 'Assign sales & purchase targets' },
  { flag: 'kycRequired',        label: 'KYC Required',         description: 'KYC must be completed before activation' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function OutletTypeConfigSection({ clientId, initialConfigs = [] }: Props) {
  // Initialise from prop (instant, optimistic). API fetch will override.
  const [configs, setConfigs] = useState<OutletTypeClientConfig[]>(() =>
    MASTER_OUTLET_TYPES.map((t) =>
      getOutletTypeClientConfig(clientId, t.code, initialConfigs),
    ),
  );

  const [expandedCode, setExpandedCode]   = useState<string | null>(null);
  const [loadError,    setLoadError]      = useState<string | null>(null);
  const [savingCode,   setSavingCode]     = useState<string | null>(null);
  const [saveError,    setSaveError]      = useState<string | null>(null);

  // ── Load from API on mount ──────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/gifsy/clients/${clientId}/outlet-type-configs`, {
          headers: { 'Authorization': `Bearer ${getToken()}` },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) setLoadError(body.error ?? `HTTP ${res.status}`);
          return;
        }
        const { data } = await res.json();
        if (!cancelled) {
          // Translate API response to OutletTypeClientConfig shape
          setConfigs(
            data.map((item: any) => ({
              clientId:           item.clientId,
              outletTypeCode:     item.outletTypeCode,
              isEnabled:          item.isEnabled,
              displayName:        item.displayName,
              loyaltyEnabled:     item.loyaltyEnabled,
              schemesEnabled:     item.schemesEnabled,
              visibilityEnabled:  item.visibilityEnabled,
              payoutsEnabled:     item.payoutsEnabled,
              leaderboardEnabled: item.leaderboardEnabled,
              targetsEnabled:     item.targetsEnabled,
              kycRequired:        item.kycRequired,
            })),
          );
        }
      } catch (e: any) {
        if (!cancelled) setLoadError(e.message ?? 'Network error');
      }
    }
    load();
    return () => { cancelled = true; };
  }, [clientId]);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function getConfig(code: string): OutletTypeClientConfig {
    return configs.find((c) => c.outletTypeCode === code)!;
  }

  async function saveFlag(code: string, flag: OutletTypeFeatureFlag, value: boolean) {
    // Optimistic update
    setConfigs((prev) =>
      prev.map((cfg) =>
        cfg.outletTypeCode === code
          ? applyOutletTypeClientConfigUpdate(cfg, flag, value, 'GIFSY_ADMIN')
          : cfg,
      ),
    );
    setSavingCode(code);
    setSaveError(null);
    try {
      const res = await fetch(`/api/gifsy/clients/${clientId}/outlet-type-configs/${code}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body:    JSON.stringify({ [flag]: value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSaveError(body.error ?? `Save failed (HTTP ${res.status})`);
      }
    } catch (e: any) {
      setSaveError(e.message ?? 'Network error while saving');
    } finally {
      setSavingCode(null);
    }
  }

  async function saveDisplayName(code: string, displayName: string) {
    setConfigs((prev) =>
      prev.map((cfg) =>
        cfg.outletTypeCode === code
          ? { ...cfg, displayName: displayName || null }
          : cfg,
      ),
    );
    setSavingCode(code);
    setSaveError(null);
    try {
      const res = await fetch(`/api/gifsy/clients/${clientId}/outlet-type-configs/${code}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body:    JSON.stringify({ displayName: displayName || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setSaveError(body.error ?? `Save failed (HTTP ${res.status})`);
      }
    } catch (e: any) {
      setSaveError(e.message ?? 'Network error while saving');
    } finally {
      setSavingCode(null);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="pt-2 space-y-2">
      {loadError && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          Could not load configs: {loadError}. Showing defaults.
        </div>
      )}
      {saveError && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {saveError}
        </div>
      )}

      {MASTER_OUTLET_TYPES.map((type) => {
        const cfg      = getConfig(type.code);
        const expanded = expandedCode === type.code;
        const saving   = savingCode === type.code;

        return (
          <OutletTypeCard
            key={type.code}
            type={type}
            config={cfg}
            expanded={expanded}
            saving={saving}
            onToggleExpand={() => setExpandedCode(expanded ? null : type.code)}
            onToggleEnabled={() => saveFlag(type.code, 'isEnabled', !cfg.isEnabled)}
            onToggleFlag={(flag, value) => saveFlag(type.code, flag, value)}
            onChangeDisplayName={(name) => saveDisplayName(type.code, name)}
          />
        );
      })}

      <p className="text-xs text-white/30 pt-1 px-1">
        These settings apply only to this client. The global outlet type master list is managed in{' '}
        <a href="/gifsy/outlet-types" className="underline hover:text-white/50 transition-colors">
          Outlet Types
        </a>
        .
      </p>
    </div>
  );
}

// ── Token helper (reads from session cookie / localStorage) ───────────────────

function getToken(): string {
  // Platform uses cookie-based auth. The JWT is stored under 'token' in localStorage
  // (set by the verify-otp action). Falls back to empty string if unavailable.
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('token') ?? '';
}

// ── Card ──────────────────────────────────────────────────────────────────────

interface CardProps {
  type: OutletType;
  config: OutletTypeClientConfig;
  expanded: boolean;
  saving: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: () => void;
  onToggleFlag: (flag: OutletTypeFeatureFlag, value: boolean) => void;
  onChangeDisplayName: (name: string) => void;
}

function OutletTypeCard({
  type, config, expanded, saving,
  onToggleExpand, onToggleEnabled, onToggleFlag, onChangeDisplayName,
}: CardProps) {
  // Local state for the display name input so we don't save on every keystroke
  const [draftName, setDraftName] = useState(config.displayName ?? '');
  const prevDisplayName = useRef(config.displayName);

  // Keep local draft in sync when config changes externally (API load)
  useEffect(() => {
    if (config.displayName !== prevDisplayName.current) {
      setDraftName(config.displayName ?? '');
      prevDisplayName.current = config.displayName;
    }
  }, [config.displayName]);

  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${
      config.isEnabled
        ? 'border-white/10 bg-white/5'
        : 'border-white/5 bg-white/2 opacity-60'
    }`}>
      {/* ── Card header ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* isEnabled toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={config.isEnabled}
          aria-label="Enable for this client"
          onClick={(e) => { e.stopPropagation(); onToggleEnabled(); }}
          className={`relative w-9 h-5 rounded-full shrink-0 transition-colors focus:outline-none ${
            config.isEnabled ? 'bg-[var(--brand-primary)]' : 'bg-white/15'
          }`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            config.isEnabled ? 'translate-x-4' : 'translate-x-0.5'
          }`} />
        </button>

        {/* Name + code */}
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-sm font-semibold text-white">{type.name}</span>
          {type.code !== type.name && (
            <span className="font-mono text-[10px] text-white/30 bg-white/5 border border-white/10 px-1.5 py-0.5 rounded">
              {type.code}
            </span>
          )}
          {saving && <Loader2 className="w-3 h-3 text-white/30 animate-spin" />}
        </div>

        {/* Expand / configure button */}
        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={expanded ? `Collapse ${type.name}` : `Configure ${type.name}`}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-white/40 hover:text-white border border-white/10 hover:border-white/20 rounded-lg transition-colors"
        >
          <Settings2 className="w-3 h-3" />
          Configure
          {expanded
            ? <ChevronUp className="w-3 h-3" />
            : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {/* ── Expanded body ─────────────────────────────────────────────────── */}
      {expanded && (
        <div className="border-t border-white/5 px-4 py-4 space-y-4">
          {/* Display name override */}
          <div>
            <label
              htmlFor={`display-name-${type.code}`}
              className="block text-xs text-white/50 mb-1.5"
            >
              Custom name
              <span className="ml-1.5 text-white/25">(overrides "{type.name}" for this client only)</span>
            </label>
            <div className="flex items-center gap-2 max-w-xs">
              <input
                id={`display-name-${type.code}`}
                aria-label="Custom name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => {
                  if (draftName !== (config.displayName ?? '')) {
                    onChangeDisplayName(draftName);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    onChangeDisplayName(draftName);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                placeholder={`Leave blank to use "${type.name}"`}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
              />
            </div>
            <p className="text-[10px] text-white/25 mt-1">Press Enter or click away to save</p>
          </div>

          {/* Feature flags */}
          <div>
            <p className="text-xs text-white/50 mb-2 font-medium">Feature flags</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {FLAG_META.map(({ flag, label, description }) => {
                const on = config[flag] as boolean;
                return (
                  <div
                    key={flag}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/5 border border-white/5 hover:border-white/10 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-white/80">{label}</p>
                      <p className="text-[10px] text-white/30 mt-0.5 leading-tight">{description}</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={label}
                      onClick={() => onToggleFlag(flag, !on)}
                      className={`relative w-8 h-4 rounded-full shrink-0 transition-colors focus:outline-none ${
                        on ? 'bg-[var(--brand-primary)]' : 'bg-white/15'
                      }`}
                    >
                      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
                        on ? 'translate-x-4' : 'translate-x-0.5'
                      }`} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
