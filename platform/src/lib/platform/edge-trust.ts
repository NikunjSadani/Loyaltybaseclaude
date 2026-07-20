/**
 * S1 — edge trust boundary for the client-controllable `x-forwarded-host`.
 *
 * The Cloud Run origins are public (*.run.app), so a client hitting the origin
 * DIRECTLY (bypassing the Cloudflare edge worker) could forge `x-forwarded-host`
 * to control tenant resolution (which tenant's branding renders / which clientId an
 * OTP is scoped to). The worker stamps `x-edge-secret` on every forwarded request;
 * we only TRUST the inbound `x-forwarded-host` when that secret matches.
 *
 * A direct hit (no / wrong secret) falls back to the real `Host` header → the
 * `.run.app` host → resolves to no tenant → safe. When `EDGE_SECRET` is unset
 * (local dev / pre-rollout) the header is trusted as before, so shipping this is a
 * safe, env-gated, reversible rollout (unset the env → prior behaviour).
 *
 * Shared by `proxy.ts` (edge middleware) and `auth/login/actions.ts` (server action),
 * both of which resolve the tenant from the request host.
 *
 * @param getHeader   header accessor (e.g. `(n) => request.headers.get(n)`).
 * @param edgeSecret  the configured shared secret; defaults to `process.env.EDGE_SECRET`.
 */
export function resolveTrustedHost(
  getHeader: (name: string) => string | null,
  edgeSecret: string | undefined = process.env.EDGE_SECRET,
): string | null {
  const edgeVerified = !edgeSecret || getHeader('x-edge-secret') === edgeSecret;
  return (edgeVerified ? getHeader('x-forwarded-host') : null) ?? getHeader('host');
}
