import type { CSSProperties } from 'react';

export type BannerType  = 'text' | 'video';
export type PopupType   = 'text' | 'video' | 'image';
export type PopupFrequency = 'always' | 'once' | 'daily';
export type BannerAudience = 'ALL' | 'SSS' | 'WHOLESALER' | 'SUB_STOCKIST';

// ── Strip banner (top of home page) ─────────────────────────────────────────
export interface Banner {
  id: string;
  active: boolean;
  type: BannerType;
  title: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  videoUrl: string;
  bgColor: string;
  audience: BannerAudience;
  /** Display order — lower number = shown first. Default 0. */
  priority: number;
  /**
   * ISO date string (YYYY-MM-DD).  Empty string = no lower bound.
   * Banner will not be shown before this date.
   */
  startDate: string;
  /**
   * ISO date string (YYYY-MM-DD).  Empty string = no upper bound.
   * Banner will not be shown after this date.
   */
  endDate: string;
  /**
   * When true, this banner is also shown to the internal sales team
   * (SALES_SO, TERRITORY_SALES_OFFICER, etc.) in their dashboard.
   * Default false — does not affect the partner-facing banner display.
   */
  showInSalesApp: boolean;
  updatedAt: string;
}

// ── Full-screen popup ────────────────────────────────────────────────────────
export interface Popup {
  id: string;
  active: boolean;
  type: PopupType;
  title: string;
  body: string;
  imageUrl: string;      // direct image URL (for poster/image type)
  videoUrl: string;      // YouTube URL (for video type)
  ctaLabel: string;
  ctaUrl: string;
  bgColor: string;
  frequency: PopupFrequency;  // how often to show
  audience: BannerAudience;
  updatedAt: string;
}

// ── Shared constants ─────────────────────────────────────────────────────────
const BANNER_KEY = 'loyaltybase_banners';
const POPUP_KEY  = 'loyaltybase_popups';
const POPUP_SEEN_KEY = 'loyaltybase_popup_seen'; // {[popupId]: isoDate}

export const BG_OPTIONS: { label: string; value: string; from: string; to: string }[] = [
  { label: 'Red',    value: 'red',    from: 'var(--brand-primary)', to: 'var(--brand-primary-dark)' },
  { label: 'Navy',   value: 'navy',   from: '#1A1A2E', to: '#16213E' },
  { label: 'Green',  value: 'green',  from: '#065f46', to: '#047857' },
  { label: 'Amber',  value: 'amber',  from: '#92400e', to: '#b45309' },
  { label: 'Indigo', value: 'indigo', from: '#3730a3', to: '#4338ca' },
];

export function getBgStyle(bgColor: string): CSSProperties {
  const opt = BG_OPTIONS.find((o) => o.value === bgColor) ?? BG_OPTIONS[0];
  return { background: `linear-gradient(135deg, ${opt.from}, ${opt.to})` };
}

export function toEmbedUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return `https://www.youtube.com/embed${u.pathname}`;
    const v = u.searchParams.get('v');
    if (v) return `https://www.youtube.com/embed/${v}`;
  } catch { /* not a valid URL */ }
  return url;
}

// ── Banner CRUD ──────────────────────────────────────────────────────────────
export function loadBanners(): Banner[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(BANNER_KEY) ?? '[]'); } catch { return []; }
}
export function saveBanners(banners: Banner[]): void {
  localStorage.setItem(BANNER_KEY, JSON.stringify(banners));
}
/** Returns the first active banner (legacy single-banner consumers). */
export function getActiveBanner(): Banner | null {
  return getActiveBanners()[0] ?? null;
}

/**
 * Returns all active, in-schedule banners sorted by priority ascending (0 = highest priority).
 *
 * Scheduling rules (both bounds are inclusive, compared at day granularity):
 *  - startDate empty → no lower bound
 *  - endDate   empty → no upper bound
 *  - Both empty      → always in window when active
 */
export function getActiveBanners(): Banner[] {
  const today = todayDateString();
  return loadBanners()
    .filter((b) => {
      if (!b.active) return false;
      if (b.startDate && today < b.startDate) return false;
      if (b.endDate   && today > b.endDate)   return false;
      return true;
    })
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

/** Returns today's date as 'YYYY-MM-DD' in the local/UTC timezone. */
function todayDateString(): string {
  const d = new Date();
  // Use ISO string and slice the date part (UTC — consistent with date inputs)
  return d.toISOString().slice(0, 10);
}

export function newBanner(): Banner {
  return {
    id: crypto.randomUUID(), active: false, type: 'text',
    title: '', body: '', ctaLabel: '', ctaUrl: '',
    videoUrl: '', bgColor: 'red', audience: 'ALL',
    priority: 0,
    startDate: '',
    endDate: '',
    showInSalesApp: false,
    updatedAt: new Date().toISOString(),
  };
}

// ── API helpers (server-backed, replaces localStorage for cross-session use) ──

function authHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fetch the full banner + popup list from the server.
 * Returns `{ banners: [], popups: [] }` on any error so the UI degrades gracefully.
 */
export async function fetchBanners(): Promise<{ banners: Banner[]; popups: Popup[] }> {
  try {
    const res = await fetch('/api/admin/banner-config', {
      headers: { ...authHeader() },
    });
    if (!res.ok) return { banners: [], popups: [] };
    const json = await res.json();
    return {
      banners: json.data?.banners ?? [],
      popups:  json.data?.popups  ?? [],
    };
  } catch {
    return { banners: [], popups: [] };
  }
}

/**
 * Persist the full banner + popup list to the server.
 */
export async function updateBanners(config: { banners: Banner[]; popups: Popup[] }): Promise<void> {
  await fetch('/api/admin/banner-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(config),
  });
}

/**
 * Returns active, in-schedule banners that are targeted at the sales team,
 * sorted by priority ascending (0 = highest priority).
 *
 * Scheduling rules (both bounds inclusive, empty string = no bound).
 */
export function getActiveSalesBanners(banners: Banner[]): Banner[] {
  const today = new Date().toISOString().slice(0, 10);
  return banners
    .filter((b) => {
      if (!b.active)          return false;
      if (!b.showInSalesApp)  return false;
      if (b.startDate && today < b.startDate) return false;
      if (b.endDate   && today > b.endDate)   return false;
      return true;
    })
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

// ── Popup CRUD ───────────────────────────────────────────────────────────────
export function loadPopups(): Popup[] {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(localStorage.getItem(POPUP_KEY) ?? '[]'); } catch { return []; }
}
export function savePopups(popups: Popup[]): void {
  localStorage.setItem(POPUP_KEY, JSON.stringify(popups));
}
export function getActivePopup(): Popup | null {
  return loadPopups().find((p) => p.active) ?? null;
}
export function newPopup(): Popup {
  return {
    id: crypto.randomUUID(), active: false, type: 'text',
    title: '', body: '', imageUrl: '', videoUrl: '',
    ctaLabel: '', ctaUrl: '', bgColor: 'red',
    frequency: 'once', audience: 'ALL',
    updatedAt: new Date().toISOString(),
  };
}

// ── Popup frequency logic ────────────────────────────────────────────────────
export function shouldShowPopup(popup: Popup): boolean {
  if (!popup.active) return false;
  if (popup.frequency === 'always') return true;
  try {
    const seen: Record<string, string> = JSON.parse(localStorage.getItem(POPUP_SEEN_KEY) ?? '{}');
    const lastSeen = seen[popup.id];
    if (!lastSeen) return true;
    if (popup.frequency === 'once') return false;
    // daily: show if last seen was not today
    if (popup.frequency === 'daily') {
      const today = new Date().toDateString();
      return new Date(lastSeen).toDateString() !== today;
    }
  } catch { /* ignore */ }
  return true;
}

export function markPopupSeen(popupId: string): void {
  try {
    const seen: Record<string, string> = JSON.parse(localStorage.getItem(POPUP_SEEN_KEY) ?? '{}');
    seen[popupId] = new Date().toISOString();
    localStorage.setItem(POPUP_SEEN_KEY, JSON.stringify(seen));
  } catch { /* ignore */ }
}
