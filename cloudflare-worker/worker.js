/**
 * Cloudflare Worker — gifsy.in LB replacement
 *
 * Routes incoming requests on gifsy.in subdomains to the appropriate
 * Cloud Run service, setting headers so Cloud Run's Host-based routing
 * works and so Next.js proxy.ts can resolve the tenant from
 * X-Forwarded-Host instead of Host.
 *
 * §A-DOMAIN Phase 3 — TENANT-AGNOSTIC frontend routing:
 *   The frontend origin is now resolved by a COARSE rule, not a per-host
 *   dictionary. Any `*.gifsy.in` host that is not an explicit API host and
 *   not on the RESERVED denylist routes to the frontend Cloud Run origin,
 *   so onboarding a new tenant frontend host needs NO worker edit — only a
 *   DB/registry domain→slug row (read by Next) and DNS (see wrangler.toml).
 *   Only the API hosts stay explicit (they point at a non-frontend origin).
 *   prod vs staging split is purely the `uat.` prefix.
 *
 * Deployment steps (one-time, done by a human):
 *   1. Add gifsy.in to Cloudflare (change NS at registrar)
 *   2. npx wrangler deploy   (from this directory)
 *   3. Ensure a proxied wildcard `*.gifsy.in` DNS record + wildcard TLS exist
 *      in the zone so the coarse worker route can serve any tenant host.
 */

// Cloud Run origins (exact strings — do not invent new ones).
const FRONTEND_PROD    = 'https://gifsy-frontend-4d4n5mc6yq-el.a.run.app'
const FRONTEND_STAGING = 'https://gifsy-frontend-staging-4d4n5mc6yq-el.a.run.app'
const API_PROD         = 'https://gifsy-api-4d4n5mc6yq-el.a.run.app'
const API_STAGING      = 'https://gifsy-api-staging-4d4n5mc6yq-el.a.run.app'

// API hosts are the ONLY hosts that point at a non-frontend origin, so they
// stay explicit. Everything else under gifsy.in is a frontend host.
const API_ROUTES = {
  'api.gifsy.in':         API_PROD,
  'api.staging.gifsy.in': API_STAGING,
}

// Reserved hosts that must NOT be treated as tenant frontends (mirrors the
// Next PLATFORM_RESERVED denylist). These return 502 rather than silently
// resolving to a tenant frontend.
const RESERVED_HOSTS = new Set([
  'www.gifsy.in',
  'mail.gifsy.in',
  'status.gifsy.in',
])

/**
 * Resolve the Cloud Run origin for an incoming public hostname.
 * - Explicit API host        → its API origin.
 * - Reserved host            → null (caller returns 502).
 * - Any other *.gifsy.in host → frontend origin (staging if `uat.` prefixed,
 *   else prod). Tenant slug resolution is Next's job via x-forwarded-host.
 */
function resolveOrigin(hostname) {
  const apiOrigin = API_ROUTES[hostname]
  if (apiOrigin) return apiOrigin

  if (RESERVED_HOSTS.has(hostname)) return null

  // Coarse frontend rule: uat.* → staging, everything else → prod.
  return hostname.startsWith('uat.') ? FRONTEND_STAGING : FRONTEND_PROD
}

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url)
    const hostname = url.hostname

    const backendBase = resolveOrigin(hostname)
    if (!backendBase) {
      return new Response(`No backend configured for host: ${hostname}`, { status: 502 })
    }

    // Construct the backend URL preserving path and query string.
    const backendUrl = new URL(url.pathname + url.search, backendBase)

    // Forward all original headers.
    // - Host will be set automatically to the backendBase hostname by fetch().
    // - X-Forwarded-Host carries the REAL public hostname so that Next.js
    //   proxy.ts can resolve the correct tenant slug. Next strips the `uat.`
    //   prefix and reads the DB/registry domain→slug map itself, so the edge
    //   forwards the real host with NO alias.
    const headers = new Headers(request.headers)
    headers.set('x-forwarded-host', hostname)
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''))
    // S1 — the *.run.app origins are public, so a direct hit could forge x-forwarded-host.
    // Stamp a shared secret so the frontend only TRUSTS x-forwarded-host on worker-forwarded
    // requests. Strip any inbound value first so a client can't smuggle one THROUGH the
    // worker. No-op until EDGE_SECRET is configured (safe, reversible rollout).
    headers.delete('x-edge-secret')
    if (env && env.EDGE_SECRET) headers.set('x-edge-secret', env.EDGE_SECRET)
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
