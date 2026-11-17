/**
 * The Hubble brands (products) Voucher Dispersal can buy, on the PLATFORM Hubble account.
 *
 * Default registry = the product ids already used in production for Bajaj's catalogue
 * (BAJAJ-PROD-GO-LIVE-CHECKLIST.md F2): Amazon Pay + Flipkart. Their limits / denominations are NEVER
 * hard-coded — they are read live from Hubble (GET /v1/partners/products/:id) on every brands call,
 * upload validation and (defence in depth) before each buy.
 *
 * Override per environment with VOUCHER_DISPERSAL_BRANDS = JSON array of {key,label,productId}
 * (e.g. to add a brand or to point at a different product id) — no deploy-time code change needed.
 * A malformed override is IGNORED (logged by the caller) and the default registry is used.
 */
export interface DispersalBrandConfig {
  /** Stable machine key (upper-case, e.g. AMAZON_PAY). */
  key: string;
  /** Human label shown in the template dropdown + report (e.g. "Amazon Pay"). */
  label: string;
  /** Hubble product id (ULID). */
  productId: string;
}

export const DEFAULT_DISPERSAL_BRANDS: readonly DispersalBrandConfig[] = [
  { key: 'AMAZON_PAY', label: 'Amazon Pay', productId: '01HDRPKWFE2SMVM54TWD8S1927' },
  { key: 'FLIPKART', label: 'Flipkart', productId: '01GMMNJECTDZAG2YS61K58HVG8' },
];

/** Parse the env override; returns null when absent or malformed (caller falls back to the default). */
export function parseBrandOverride(raw: string | undefined | null): DispersalBrandConfig[] | null {
  if (!raw || !raw.trim()) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const out: DispersalBrandConfig[] = [];
    const seen = new Set<string>();
    for (const b of arr) {
      if (!b || typeof b !== 'object') return null;
      const o = b as Record<string, unknown>;
      const key = typeof o.key === 'string' ? o.key.trim().toUpperCase() : '';
      const label = typeof o.label === 'string' ? o.label.trim() : '';
      const productId = typeof o.productId === 'string' ? o.productId.trim() : '';
      if (!/^[A-Z0-9_]{1,40}$/.test(key) || !label || !/^[A-Za-z0-9_-]{1,64}$/.test(productId)) return null;
      // Keys and labels share ONE namespace (an upload cell may hold either), case-insensitively.
      if (seen.has(key.toLowerCase()) || seen.has(label.toLowerCase())) return null;
      seen.add(key.toLowerCase());
      if (label.toLowerCase() !== key.toLowerCase()) seen.add(label.toLowerCase());
      out.push({ key, label, productId });
    }
    return out;
  } catch {
    return null;
  }
}

/** The configured brands (override when valid, else the default registry). */
export function configuredDispersalBrands(env: NodeJS.ProcessEnv = process.env): DispersalBrandConfig[] {
  return parseBrandOverride(env.VOUCHER_DISPERSAL_BRANDS) ?? DEFAULT_DISPERSAL_BRANDS.map((b) => ({ ...b }));
}
