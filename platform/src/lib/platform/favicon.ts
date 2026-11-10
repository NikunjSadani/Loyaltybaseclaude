/**
 * Browser-tab favicon href selection (shared by the root layout <head>).
 *
 * Two provenance classes exist for `branding.faviconUrl`:
 *   1. Console-provisioned tenant (§A-DOMAIN): the operator uploads a favicon via
 *      the Gifsy console → it is served by the PUBLIC same-origin branding route
 *      (`/api/public/branding-assets?key=branding/<slug>/…`; the uploads bucket is
 *      private, so a raw `https://storage.googleapis.com/…` URL 403s — the API maps any
 *      legacy stored GCS value to the route at read time). Such a tenant has NO committed
 *      static assets under `public/icons/<slug>/`, so the static slug path would 404 —
 *      the DB URL is the ONLY working favicon and must win.
 *   2. Legacy in-code registry tenant (deoleo, clientb): `branding.faviconUrl` is a
 *      LOCAL path (`/favicons/<slug>.ico`). The CANONICAL committed art lives at
 *      `public/icons/<slug>/favicon.ico` (the same static slug path that has always
 *      served the browser tab); `public/favicons/<slug>.ico` is also committed as a
 *      byte-identical copy so the stored value itself resolves for any direct consumer.
 *
 * So: prefer `branding.faviconUrl` ONLY when it is an absolute http(s) URL or the
 * branding-asset route (class 1); otherwise fall back to the canonical `/icons/<slug>/favicon.ico`
 * static path (class 2). We never prefer a LOCAL faviconUrl even now that the copies
 * exist — the helper can't stat a URL at render time, so absolute-http(s)-only keeps a
 * single canonical location and can never regress a legacy tenant to a 404. It also
 * degrades gracefully: the day a legacy tenant uploads a real favicon via the console,
 * its value becomes an absolute URL and correctly wins.
 */
/** The public same-origin branding-image route (api PublicBrandingAssetController via /api → /v1). */
const BRANDING_ASSET_ROUTE = '/api/public/branding-assets';

export function resolveFaviconIcoHref(
  faviconUrl: string | undefined | null,
  slug: string,
): string {
  const url = (faviconUrl ?? '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith(`${BRANDING_ASSET_ROUTE}?`)) return url;
  return `/icons/${slug}/favicon.ico`;
}
