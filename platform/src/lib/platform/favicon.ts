/**
 * Browser-tab favicon href selection (shared by the root layout <head>).
 *
 * Two provenance classes exist for `branding.faviconUrl`:
 *   1. Console-provisioned tenant (§A-DOMAIN): the operator uploads a favicon via
 *      the Gifsy console → it is stored as an ABSOLUTE GCS object URL
 *      (`https://storage.googleapis.com/<bucket>/branding/<slug>/…`). Such a tenant
 *      has NO committed static assets under `public/icons/<slug>/`, so the static
 *      slug path would 404 — the DB URL is the ONLY working favicon and must win.
 *   2. Legacy in-code registry tenant (deoleo, clientb): `branding.faviconUrl` is a
 *      LOCAL path (`/favicons/<slug>.ico`). The CANONICAL committed art lives at
 *      `public/icons/<slug>/favicon.ico` (the same static slug path that has always
 *      served the browser tab); `public/favicons/<slug>.ico` is also committed as a
 *      byte-identical copy so the stored value itself resolves for any direct consumer.
 *
 * So: prefer `branding.faviconUrl` ONLY when it is an absolute http(s) URL (class 1,
 * always resolvable); otherwise fall back to the canonical `/icons/<slug>/favicon.ico`
 * static path (class 2). We never prefer a LOCAL faviconUrl even now that the copies
 * exist — the helper can't stat a URL at render time, so absolute-http(s)-only keeps a
 * single canonical location and can never regress a legacy tenant to a 404. It also
 * degrades gracefully: the day a legacy tenant uploads a real favicon via the console,
 * its value becomes an absolute URL and correctly wins.
 */
export function resolveFaviconIcoHref(
  faviconUrl: string | undefined | null,
  slug: string,
): string {
  const url = (faviconUrl ?? '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  return `/icons/${slug}/favicon.ico`;
}
