/* ─── Gifsy Configurable Settings ────────────────────────────────────────────
   All values are set by the Gifsy admin from the admin portal.
   Stored in localStorage for the demo; in production these come from the API.
─────────────────────────────────────────────────────────────────────────────── */

import type { GifsySettings } from '@/types';

const SETTINGS_KEY = 'gifsy_settings_v1';

export const DEFAULT_SETTINGS: GifsySettings = {
  pointsConversionRate:    1,    // 1 pt = ₹1
  minBankTransferAmount:   250,  // minimum ₹250 for bank transfer redemption (Deoleo default)
  minVoucherFreeAmount:    250,  // minimum ₹250 for free-amount voucher redemption (Deoleo default)
  paceAmberThreshold:      10,   // amber if gap ≤ 10% of time elapsed (Deoleo default; range 1–30)
  visibilityPhotoEnabled:  false, // Deoleo captures photos via their own portal
  redemptionChannels: {
    physicalGifts: true,
    vouchers:      true,
    bankTransfer:  true,
  },
  creditsPayouts: {
    monthCutoffDay:  28,
    safetyCapPoints: 50000,
    safetyCapInr:    100000,
    fourEyesEnabled: false,
    notifyEmails:    ['nikunj.sadani@gifsy.in', 'nikita@gifsy.in'],
  },
  salesApp: {
    ledgerLabel:              'Wallet',
    redeemGiftWholesalerOnly: true,
  },
};

export function getGifsySettings(): GifsySettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_SETTINGS;
}

export function saveGifsySettings(settings: Partial<GifsySettings>): void {
  if (typeof window === 'undefined') return;
  try {
    const current = getGifsySettings();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...current, ...settings }));
  } catch { /* ignore */ }
}
