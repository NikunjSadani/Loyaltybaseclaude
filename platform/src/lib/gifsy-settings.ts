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
  visibilityPhotoEnabled:  false,
  visibilityCaptureMode:   'PHOTO_APPROVAL',
  redemptionChannels: {
    physicalGifts: true,
    vouchers:      true,
    bankTransfer:  true,
  },
  salesApp: {
    ledgerLabel:              'Wallet',
    redeemGiftWholesalerOnly: true,
    upiEnabled:               false,
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
};

/** Server `EffectiveSettings` shape (GET /v1/settings / me.settings). */
interface ServerSettings {
  conversionRate:         number;
  minBankTransferAmount:  number;
  minVoucherFreeAmount:   number;
  paceAmberThreshold:     number;
  visibilityEnabled:      boolean;
  visibilityPhotoEnabled: boolean;
  /** Present on the /me settings block only (authoritative ClientConfig flag). */
  visibilityCaptureMode?: 'PHOTO_APPROVAL' | 'AMOUNT_UPLOAD';
  redemptionChannels:     GifsySettings['redemptionChannels'];
  salesApp:               GifsySettings['salesApp'];
  creditsPayouts?:        GifsySettings['creditsPayouts'];
  outletPrograms:         string[];
  outletCategories:       string[];
}

// ── in-memory store (seeded synchronously from the localStorage cache) ────────
let store: GifsySettings = loadCache();
let refreshedThisSession = false;
const listeners = new Set<() => void>();

function loadCache(): GifsySettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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
    visibilityPhotoEnabled: srv.visibilityPhotoEnabled ?? prev.visibilityPhotoEnabled,
    visibilityCaptureMode:  srv.visibilityCaptureMode  ?? prev.visibilityCaptureMode ?? 'PHOTO_APPROVAL',
    redemptionChannels:     srv.redemptionChannels     ?? prev.redemptionChannels,
    salesApp:               srv.salesApp               ?? prev.salesApp,
    // /me omits creditsPayouts (operator-only) — keep the previous/cached value then.
    creditsPayouts:         srv.creditsPayouts         ?? prev.creditsPayouts,
    outletPrograms:         srv.outletPrograms         ?? prev.outletPrograms,
    outletCategories:       srv.outletCategories       ?? prev.outletCategories,
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
  visibilityPhotoEnabled: 'visibilityPhotoEnabled',
  redemptionChannels:     'redemptionChannels',
  salesApp:               'salesApp',
  creditsPayouts:         'creditsPayouts',
  // Allow-lists saved as whole arrays (REPLACE-WHOLE — correct for a list editor).
  outletPrograms:         'outletPrograms',
  outletCategories:       'outletCategories',
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
  const entries = Object.entries(partial) as [keyof GifsySettings, unknown][];
  let allOk = true;
  for (const [key, value] of entries) {
    const settingKey = SAVE_KEY_MAP[key];
    if (!settingKey) continue;
    const res = await api.put('/api/admin/settings', { key: settingKey, value });
    if (!res.success) allOk = false;
  }
  if (allOk) writeCache({ ...store, ...partial });
  return allOk;
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
