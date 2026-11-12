/**
 * Public branding assets (tenant logos / wordmarks / favicons).
 *
 * Branding images are uploaded by the Gifsy console into the PRIVATE uploads bucket
 * (`gifsy-platform-files`, which also holds KYC docs + POSM photos), under the
 * `branding/<slug>/<yyyy-mm>/<uuid>-<name>.<ext>` prefix. A raw
 * `https://storage.googleapis.com/<bucket>/branding/...` URL therefore 403s in a browser.
 * They must render PRE-LOGIN (the sign-in screen, favicon), so they are served by the
 * unauthenticated `GET /v1/public/branding-assets?key=<key>` route — which only ever reads
 * keys that pass `normaliseBrandingKey` below (the `branding/` prefix, exact upload shape).
 *
 * URL form: a SAME-ORIGIN relative path `/api/public/branding-assets?key=…` (the frontend
 * rewrites `/api/*` → backend `/v1/*`). It works unchanged on every tenant host (branded
 * custom domains included), needs no CORS / Cross-Origin-Resource-Policy relaxation (helmet's
 * CORP `same-origin` is satisfied because the browser sees the tenant origin), and is the
 * established pattern (`/api/gift-images?key=…`).
 */

export const BRANDING_ASSET_PREFIX = 'branding/';
/** Browser-facing route (via the FE `/api` → `/v1` rewrite). */
export const BRANDING_ASSET_ROUTE = '/api/public/branding-assets';
/** Serve cap = the upload cap. */
export const BRANDING_ASSET_MAX_BYTES = 5 * 1024 * 1024;
/** The only types served (and accepted on upload): browser-renderable raster images. */
export const BRANDING_ASSET_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const MAX_KEY_LENGTH = 300;
/**
 * Exactly the shape `StorageService.generateKey('branding/<slug>', name)` produces:
 * `branding/<slug>/<YYYY-MM>/<uuid>-<sanitised base>[.<ext>]`. The charset excludes `.`
 * outside the single extension, `/` beyond the fixed segments, `\`, `%`, `?`, `#` and
 * control bytes — so traversal, other prefixes and encoded tricks can never match.
 */
const KEY_RE =
  /^branding\/[a-z0-9][a-z0-9-]{0,62}\/\d{4}-(0[1-9]|1[0-2])\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9_-]{0,200}(\.[A-Za-z0-9]{1,10})?$/;

/** Validate an untrusted key; returns it unchanged when it is a branding object key, else null. */
export function normaliseBrandingKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_KEY_LENGTH) return null;
  if (!KEY_RE.test(raw)) return null;
  return raw;
}

/** The browser URL for a branding object key. */
export function brandingAssetRouteUrl(key: string): string {
  return `${BRANDING_ASSET_ROUTE}?key=${encodeURIComponent(key)}`;
}

/** The configured uploads bucket — same cleaning + default as StorageService. */
function configuredBucket(): string {
  return process.env.GCS_BUCKET?.replace(/^﻿/, '').trim() || 'gifsy-platform-files';
}

/**
 * READ-TIME mapping for stored branding URLs (no data migration): a legacy
 * `https://storage.googleapis.com/<our bucket>/branding/...` value (written by uploads
 * before the public route existed) becomes the public route URL. EVERYTHING else — static
 * paths like `/brand/…`, `/logos/…`, `/favicons/…` (Deoleo), external URLs, other buckets,
 * other prefixes, already-mapped values, non-strings — is returned byte-for-byte unchanged.
 */
export function toServableBrandingUrl<T>(url: T, bucket: string = configuredBucket()): T | string {
  if (typeof url !== 'string') return url;
  const base = `https://storage.googleapis.com/${bucket}/`;
  if (!url.startsWith(base)) return url;
  const key = normaliseBrandingKey(url.slice(base.length));
  return key ? brandingAssetRouteUrl(key) : url;
}
