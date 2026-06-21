/**
 * Cloudflare Worker — gifsy.in LB replacement
 *
 * Routes incoming requests on gifsy.in subdomains to the appropriate
 * Cloud Run service, setting headers so Cloud Run's Host-based routing
 * works and so Next.js proxy.ts can resolve the tenant from
 * X-Forwarded-Host instead of Host.
 *
 * Deployment steps (one-time, done by a human):
 *   1. Add gifsy.in to Cloudflare (change NS at registrar)
 *   2. npx wrangler deploy   (from this directory)
 *   3. In Cloudflare dashboard → Workers & Pages → gifsy-proxy →
 *      Settings → Triggers → Custom Domains: add each subdomain
 *      (api.gifsy.in, platform.gifsy.in, deoleo.gifsy.in, deoleoloyalty.gifsy.in, clientb.gifsy.in, gifsy.in)
 */

// Map each public hostname to its Cloud Run origin.
// The Worker fetch() will automatically set Host to the origin hostname,
// so Cloud Run routes the request correctly.
const ROUTES = {
  'api.gifsy.in':      'https://gifsy-api-4d4n5mc6yq-el.a.run.app',
  'platform.gifsy.in': 'https://gifsy-frontend-4d4n5mc6yq-el.a.run.app',
  'deoleo.gifsy.in':   'https://gifsy-frontend-4d4n5mc6yq-el.a.run.app',
  'clientb.gifsy.in':  'https://gifsy-frontend-4d4n5mc6yq-el.a.run.app',
  'deoleoloyalty.gifsy.in': 'https://gifsy-frontend-4d4n5mc6yq-el.a.run.app', // Deoleo branded custom domain → resolves to tenant `deoleo`
  'uat.deoleoloyalty.gifsy.in': 'https://gifsy-frontend-staging-4d4n5mc6yq-el.a.run.app', // UAT view → STAGING frontend (current build, for owner UAT)
  'api.staging.gifsy.in':      'https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app', // STAGING API — the FE's baked NEXT_PUBLIC_API_URL_STAGING targets this host; was unrouted (→ staging /api/* hung)
  // gifsy.in root is a separate website — not routed through this Worker
}

// Prod now runs current code that maps `deoleoloyalty.gifsy.in` → tenant `deoleo`
// natively, so the temporary prod host-alias was REMOVED at the 2026-06-20 cutover.
// The one remaining alias is UAT-only: `uat.deoleoloyalty.gifsy.in` runs the STAGING
// build, which resolves `deoleoloyalty.gifsy.in` → deoleo natively — so present UAT as that.
const TENANT_HOST_ALIAS = {
  'uat.deoleoloyalty.gifsy.in': 'deoleoloyalty.gifsy.in',
}

export default {
  async fetch(request, _env, _ctx) {
    const url = new URL(request.url)
    const hostname = url.hostname

    const backendBase = ROUTES[hostname]
    if (!backendBase) {
      return new Response(`No backend configured for host: ${hostname}`, { status: 502 })
    }

    // Construct the backend URL preserving path and query string.
    const backendUrl = new URL(url.pathname + url.search, backendBase)

    // Forward all original headers.
    // - Host will be set automatically to the backendBase hostname by fetch().
    // - X-Forwarded-Host carries the original public hostname so that
    //   Next.js proxy.ts can resolve the correct tenant slug.
    const headers = new Headers(request.headers)
    // Tenant-resolution host (aliased if the app doesn't yet know this public hostname).
    const tenantHost = TENANT_HOST_ALIAS[hostname] || hostname
    headers.set('x-forwarded-host', tenantHost)
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''))
    // Remove Cf-* headers that Cloud Run doesn't need and that might confuse it.
    headers.delete('cf-connecting-ip')
    headers.delete('cf-ipcountry')
    headers.delete('cf-ray')
    headers.delete('cf-visitor')

    const backendRequest = new Request(backendUrl.toString(), {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual', // handle redirects ourselves so we can rewrite Location
    })

    const response = await fetch(backendRequest)

    // Copy response headers and rewrite any Location header that points back
    // to the Cloud Run .run.app domain (e.g. from NextResponse.redirect).
    const responseHeaders = new Headers(response.headers)
    const location = responseHeaders.get('location')
    if (location) {
      try {
        const loc = new URL(location, backendBase)
        if (loc.hostname.endsWith('.run.app')) {
          loc.hostname = hostname
          loc.protocol = 'https:'
          responseHeaders.set('location', loc.toString())
        }
      } catch {
        // relative redirect — leave as-is
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  },
}
