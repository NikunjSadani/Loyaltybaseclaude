/* ─── Gifsy Configurable Settings (server-sourced) ───────────────────────────
   Per-tenant settings whose SERVER source of truth is `program_settings`
   (backend `TenantSettingsService`, exposed at GET /v1/settings and embedded in
   GET /v1/auth/me as `settings`). Money/credit enforcement of these values is
   done on the BACKEND; the values here drive display + UX only.

   localStorage is now a WRITE-THROUGH CACHE of the last server values (not the
   source of truth), so `getGifsySettings()` stays SYNCHRONOUS — the 18 existing
   inline call-sites keep working without flicker. The cache is refreshed from the
   server in the background (and on save). For reactive freshness in a component,
   use the `useGifsySettings()` hook.
─────────────────────────────────────────────────────────────────────────────── */

'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import type { GifsySettings } from '@/types';

const SETTINGS_KEY = 'gifsy_settings_v1';

export const DEFAULT_SETTINGS: GifsySettings = {
  pointsConversionRate:    1,
  minBankTransferAmount:   250,
  minVoucherFreeAmount:    250,
  paceAmberThreshold:      10,
  visibilityEnabled:       false,
  visibilityCaptureMode:   'PHOTO_APPROVAL',
  kycGstinRequired:        true,
  redemptionChannels: {
    physicalGifts: true,
    vouchers:      true,
    bankTransfer:  true,
  },
  salesApp: {
    ledgerLabel:              'Wallet',
    upiEnabled:               false,
    upiManualEntry:           false,
  },
  creditsPayouts: {
    monthCutoffDay:  28,
    safetyCapPoints: 50000,
    safetyCapInr:    100000,
    fourEyesEnabled: false,
    notifyEmails:    [],
  },
  outletPrograms:   ['Trade Loyalty', 'Gold Programme'],
  outletCategories: ['Premium', 'Standard', 'Economy'],
  visibilityConfig: {
    outletScope:        [],
    frequencyPerMonth:  1,
    allowedSalesLevels: [],
    geoFence:           { enabled: false, radiusMeters: 50 },
  },
  // Identity/payout uniqueness — default preserves today's behaviour (GST + phone enforced;
  // bank/UPI were never checked). PAN + GST are always DB-enforced regardless of the flags.
  uniquenessPolicy: { gst: true, phone: true, bank: false, upi: false },
  // The policy as STORED (admin display + save base). Same default as the derived policy.
  uniquenessPolicyStored: { gst: true, phone: true, bank: false, upi: false },
};

/** Server `EffectiveSettings` shape (GET /v1/settings / me.settings). */
interface ServerSettings {
  conversionRate:         number;
  minBankTransferAmount:  number;
  minVoucherFreeAmount:   number;
  paceAmberThreshold:     number;
  visibilityEnabled:      boolean;
  /** Present on the /me settings block only (authoritative ClientConfig flag). */
  visibilityCaptureMode?: 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD';
  kycGstinRequired:       boolean;
  redemptionChannels:     GifsySettings['redemptionChannels'];
  salesApp:               GifsySettings['salesApp'];
  creditsPayouts?:        GifsySettings['creditsPayouts'];
  outletPrograms:         string[];
  outletCategories:       string[];
  visibilityConfig?:      GifsySettings['visibilityConfig'];
  uniquenessPolicy?:      GifsySettings['uniquenessPolicy'];
  /** The policy as STORED (uniquenessPolicy is the derived/enforced value). */
  uniquenessPolicyStored?: GifsySettings['uniquenessPolicyStored'];
  otpTemplates?:          GifsySettings['otpTemplates'];
}

// ── in-memory store (seeded synchronously from the localStorage cache) ────────
let store: GifsySettings = loadCache();
let refreshedThisSession = false;
const listeners = new Set<() => void>();

function loadCache(): GifsySettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GifsySettings>;
      // A cache written before `uniquenessPolicyStored` existed: its policy came from a
      // pre-derivation server, so it IS the stored one — never let the DEFAULT stand in for it.
      if (!parsed.uniquenessPolicyStored && parsed.uniquenessPolicy) {
        parsed.uniquenessPolicyStored = parsed.uniquenessPolicy;
      }
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS;
}

function writeCache(s: GifsySettings): void {
  store = s;
  if (typeof window !== 'undefined') {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }
  listeners.forEach((l) => l());
}

/**
 * Map the server EffectiveSettings onto the FE GifsySettings shape. Every field falls back
 * to the prior cached value when a (partial/legacy) response omits it, so a refresh can never
 * STOMP a known field to undefined (which would e.g. silently hide the sales visibility action
 * or partner reward tabs). `??` (not `||`) so a legitimate 0/false is preserved.
 */
function fromServer(srv: ServerSettings, prev: GifsySettings): GifsySettings {
  return {
    pointsConversionRate:   srv.conversionRate         ?? prev.pointsConversionRate,
    minBankTransferAmount:  srv.minBankTransferAmount  ?? prev.minBankTransferAmount,
    minVoucherFreeAmount:   srv.minVoucherFreeAmount   ?? prev.minVoucherFreeAmount,
    paceAmberThreshold:     srv.paceAmberThreshold     ?? prev.paceAmberThreshold,
    visibilityEnabled:      srv.visibilityEnabled      ?? prev.visibilityEnabled,
    visibilityCaptureMode:  srv.visibilityCaptureMode  ?? prev.visibilityCaptureMode ?? 'PHOTO_APPROVAL',
    // Default TRUE when absent (GSTIN compulsory; opt-out) — prev is seeded from DEFAULT_SETTINGS (true).
    kycGstinRequired:       srv.kycGstinRequired       ?? prev.kycGstinRequired,
    redemptionChannels:     srv.redemptionChannels     ?? prev.redemptionChannels,
    salesApp:               srv.salesApp               ?? prev.salesApp,
    // /me omits creditsPayouts (operator-only) — keep the previous/cached value then.
    creditsPayouts:         srv.creditsPayouts         ?? prev.creditsPayouts,
    outletPrograms:         srv.outletPrograms         ?? prev.outletPrograms,
    outletCategories:       srv.outletCategories       ?? prev.outletCategories,
    visibilityConfig:       srv.visibilityConfig       ?? prev.visibilityConfig,
    uniquenessPolicy:       srv.uniquenessPolicy       ?? prev.uniquenessPolicy,
    // STORED policy (admin display/save base). When a response carries a policy but NO stored
    // field it is a legacy (pre-derivation) server, whose policy IS the stored one — so the
    // response's policy beats the cached stored value. (prev.uniquenessPolicyStored is always
    // seeded from DEFAULT_SETTINGS, so ranking it before srv.uniquenessPolicy would pin the
    // admin save base to the DEFAULTS on a legacy server and a save would wipe e.g. bank=true.)
    uniquenessPolicyStored: srv.uniquenessPolicyStored ?? srv.uniquenessPolicy
                            ?? prev.uniquenessPolicyStored ?? prev.uniquenessPolicy,
    otpTemplates:           srv.otpTemplates           ?? prev.otpTemplates,
  };
}

/**
 * Current settings — SYNCHRONOUS, from the write-through cache. On the first client
 * read of the session it kicks a background refresh from the server (fire-and-forget);
 * the refreshed values apply on the next render/navigation. Money is server-enforced,
 * so a brief cache lag is cosmetic.
 */
export function getGifsySettings(): GifsySettings {
  if (typeof window !== 'undefined' && !refreshedThisSession) {
    refreshedThisSession = true;
    void refreshGifsySettings();
  }
  return store;
}

/** Seed the store directly from a GET /v1/auth/me `settings` block (avoids a 2nd fetch). */
export function hydrateGifsySettings(srv: ServerSettings | null | undefined): void {
  if (!srv) return;
  writeCache(fromServer(srv, store));
}

/** Refresh from GET /v1/settings. Safe to call repeatedly. */
export async function refreshGifsySettings(): Promise<void> {
  const res = await api.get<ServerSettings>('/api/settings');
  // Guard `res.data`: a success response with an empty/absent body must NOT crash the
  // fire-and-forget refresh (fromServer dereferences srv) — it no-ops and keeps the cache.
  if (res.success && res.data) {
    writeCache(fromServer(res.data, store));
  } else if (res.success && !res.data) {
    // Success-with-empty-body → the cache stays stale (e.g. upiEnabled could lag the server).
    // Log so a silently-stale settings cache is observable rather than a mystery.
    console.warn('[gifsy-settings] /api/settings returned success with no body — settings cache left stale');
  }
}

// Partial: visibilityCaptureMode is NOT saved through here — it has its own GIFSY-only
// endpoint (PUT /v1/admin/settings/visibility-capture-mode). Keys absent from this map are
// skipped by saveGifsySettings.
const SAVE_KEY_MAP: Partial<Record<keyof GifsySettings, string>> = {
  pointsConversionRate:   'conversionRate',
  minBankTransferAmount:  'minBankTransferAmount',
  minVoucherFreeAmount:   'minVoucherFreeAmount',
  paceAmberThreshold:     'paceAmberThreshold',
  visibilityEnabled:      'visibilityEnabled',
  kycGstinRequired:       'kycGstinRequired',
  redemptionChannels:     'redemptionChannels',
  salesApp:               'salesApp',
  creditsPayouts:         'creditsPayouts',
  // Allow-lists saved as whole arrays (REPLACE-WHOLE — correct for a list editor).
  outletPrograms:         'outletPrograms',
  outletCategories:       'outletCategories',
  // Visibility (POSM) config — nested REPLACE-WHOLE key; always PUT the complete object.
  visibilityConfig:       'visibilityConfig',
  // Identity/payout uniqueness — nested REPLACE-WHOLE key; always PUT the complete object.
  uniquenessPolicy:       'uniquenessPolicy',
  // Per-purpose OTP SMS template ids — nested REPLACE-WHOLE key; always PUT the complete
  // four-purpose map (the backend 400s a partial map or a non-24-hex id).
  otpTemplates:           'otpTemplates',
};

/**
 * Persist a partial settings change to the SERVER (PUT /v1/admin/settings per key —
 * GIFSY_ADMIN only) and update the local cache on success. Returns true if every key
 * saved. Callers may fire-and-forget or await for error handling.
 *
 * ⚠️ For the NESTED keys (`redemptionChannels`, `salesApp`, `creditsPayouts`) you MUST
 * pass the COMPLETE object — the server stores each as one row and replaces it wholesale,
 * resetting any omitted sub-field to its default. Never PUT a single sub-field.
 */
export async function saveGifsySettings(partial: Partial<GifsySettings>): Promise<boolean> {
  return (await saveGifsySettingsDetailed(partial)).ok;
}

type UniqPolicy = NonNullable<GifsySettings['uniquenessPolicy']>;

function samePolicy(a: UniqPolicy | undefined, b: UniqPolicy | undefined): boolean {
  if (!a || !b) return false;
  return a.gst === b.gst && a.phone === b.phone && a.bank === b.bank && a.upi === b.upi;
}

/** The ENFORCED policy the server derives from a stored one (upi forced on by manual UPI entry). */
function derivePolicy(stored: UniqPolicy, salesApp: GifsySettings['salesApp'] | undefined): UniqPolicy {
  return { ...stored, upi: stored.upi || salesApp?.upiManualEntry === true };
}

/**
 * True when `partial` is a whole-settings SNAPSHOT echo (it carries `uniquenessPolicyStored`,
 * which no targeted save passes) whose `uniquenessPolicy` was NOT edited — i.e. it equals the
 * snapshot's own derived policy, the current derived policy, or a stored policy. A TARGETED save
 * (`{ uniquenessPolicy }` alone, e.g. the Settings uniqueness card) is always explicit.
 */
function isUnchangedPolicyEcho(partial: Partial<GifsySettings>): boolean {
  const p = partial.uniquenessPolicy;
  const snapStored = partial.uniquenessPolicyStored;
  if (!p || !snapStored) return false;
  return (
    samePolicy(p, derivePolicy(snapStored, partial.salesApp ?? store.salesApp)) ||
    samePolicy(p, store.uniquenessPolicy) ||
    samePolicy(p, snapStored) ||
    samePolicy(p, store.uniquenessPolicyStored)
  );
}

/** Outcome of a settings save: `error` is the FIRST failing PUT's server message (e.g. the
 *  backend's 400 "Turn off UPI Manual Entry first"), when one was returned. */
export interface SaveSettingsResult { ok: boolean; error?: string }

/**
 * Same as `saveGifsySettings` (identical PUTs + local cache update on success) but also returns
 * the server's error message on failure, so a caller can show WHY a save was refused instead of
 * a fixed copy. `saveGifsySettings` delegates here, so both stay byte-identical in behaviour.
 */
export async function saveGifsySettingsDetailed(partial: Partial<GifsySettings>): Promise<SaveSettingsResult> {
  // Never PUT the DERIVED (enforced) uniquenessPolicy back as the stored one: a caller that
  // echoes a whole-settings SNAPSHOT (e.g. getGifsySettings()) carries the derived value, where
  // upi is forced true while salesApp.upiManualEntry is on — persisting it would silently keep
  // UPI uniqueness ON after manual entry is turned off. An unchanged echo is replaced by the
  // STORED policy; an explicit (targeted, or edited) uniquenessPolicy is sent as-is.
  const policyToSave = partial.uniquenessPolicy
    ? (isUnchangedPolicyEcho(partial)
        ? (store.uniquenessPolicyStored ?? partial.uniquenessPolicyStored ?? partial.uniquenessPolicy)
        : partial.uniquenessPolicy)
    : undefined;
  const toSave: Partial<GifsySettings> = policyToSave ? { ...partial, uniquenessPolicy: policyToSave } : partial;
  const entries = Object.entries(toSave) as [keyof GifsySettings, unknown][];
  let allOk = true;
  let firstError: string | undefined;
  for (const [key, value] of entries) {
    const settingKey = SAVE_KEY_MAP[key];
    if (!settingKey) continue;
    const res = await api.put('/api/admin/settings', { key: settingKey, value });
    if (!res.success) {
      allOk = false;
      if (firstError === undefined && res.error) firstError = res.error;
    }
  }
  if (allOk) {
    const next: GifsySettings = { ...store, ...toSave };
    // A snapshot's own `uniquenessPolicyStored` (not a saved key) must not overwrite the cache's.
    if ('uniquenessPolicyStored' in partial) next.uniquenessPolicyStored = store.uniquenessPolicyStored;
    // `uniquenessPolicy` is PUT as the STORED policy. Mirror it into `uniquenessPolicyStored` so
    // the admin save base can never go stale, and re-derive the enforced value per the server
    // contract (upi forced true while salesApp.upiManualEntry is on). This local update is the
    // AUTHORITATIVE post-save state for the admin page: it deliberately does NOT refresh from
    // GET /settings after a save, because the server's per-instance settings cache (5 min) can
    // serve a pre-save snapshot from another instance and revert the page + the save base.
    if (policyToSave) next.uniquenessPolicyStored = policyToSave;
    if ((policyToSave || partial.salesApp) && next.uniquenessPolicyStored) {
      const stored = next.uniquenessPolicyStored;
      next.uniquenessPolicy = { ...stored, upi: stored.upi || next.salesApp?.upiManualEntry === true };
    }
    writeCache(next);
  }
  return allOk ? { ok: true } : { ok: false, ...(firstError ? { error: firstError } : {}) };
}

/** Reactive hook — re-renders on hydrate/save and refreshes from the server on mount. */
export function useGifsySettings(): GifsySettings {
  const [snapshot, setSnapshot] = useState<GifsySettings>(store);
  useEffect(() => {
    const sync = () => setSnapshot(store);
    listeners.add(sync);
    void refreshGifsySettings();
    return () => { listeners.delete(sync); };
  }, []);
  return snapshot;
}
