/* ─── Redemption store (localStorage) ───────────────────────────────────────
   Persists redemptions made on the rewards page so the wallet page can
   reflect them without a backend round-trip in the demo.
────────────────────────────────────────────────────────────────────────────── */

const KEY = 'loyaltybase_redemptions_v1';

export interface StoredRedemption {
  id:          string;
  description: string;
  points:      number;
  createdAt:   string; // ISO string
}

export function loadRedemptions(): StoredRedemption[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as StoredRedemption[];
  } catch {
    return [];
  }
}

export function saveRedemption(r: Omit<StoredRedemption, 'id' | 'createdAt'>): StoredRedemption {
  const entry: StoredRedemption = {
    ...r,
    id:        `rdm_${Date.now()}`,
    createdAt: new Date().toISOString(),
  };
  const all = loadRedemptions();
  all.unshift(entry);
  localStorage.setItem(KEY, JSON.stringify(all));
  return entry;
}

export function clearRedemptions(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(KEY);
}
