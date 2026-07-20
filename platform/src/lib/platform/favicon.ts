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
 *      LOCAL path (`/favicons/deoleo.ico`) that was NEVER committed under
 *      `public/favicons/`. The real committed art lives at
 *      `public/icons/<slug>/favicon.ico` — which is exactly the static slug path
 *      that has always served Deoleo's browser tab. Preferring the local `/favicons/…`
 *      value here would 404 and REGRESS Deoleo.
 *
 * So: prefer `branding.faviconUrl` ONLY when it is an absolute http(s) URL (class 1,
 * always resolvable); otherwise fall back to the static slug path (class 2, the
 * committed art). This also degrades gracefully — the day a legacy tenant uploads a
 * real favicon via the console, its value becomes an absolute URL and correctly wins.
 */
export function resolveFaviconIcoHref(
  faviconUrl: string | undefined | null,
  slug: string,
): string {
  const url = (faviconUrl ?? '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  return `/icons/${slug}/favicon.ico`;
}
