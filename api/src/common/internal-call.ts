import * as crypto from 'crypto';

/**
 * Server-to-server trust for headers only OUR Next server may set (security re-audit, 2026-11-20).
 *
 * The API is publicly reachable, so request headers such as `x-gifsy-no-first-use` (skip the session
 * first-use mark) or `x-client-user-agent` (the browser UA used for the device fingerprint) are only honoured
 * when the request also carries `x-internal-proxy-secret` equal to the INTERNAL_PROXY_SECRET env shared by the
 * API and the frontend services. Constant-time compare. FAIL-SAFE: when the env is unset (or < 16 chars) NOTHING
 * is trusted — the API then always marks first use and fingerprints from the request's own User-Agent.
 */
export const INTERNAL_SECRET_HEADER = 'x-internal-proxy-secret';

export function isTrustedInternalCall(
  presented: unknown,
  secret: string | undefined = process.env.INTERNAL_PROXY_SECRET,
): boolean {
  // .trim(): Windows-created secrets can carry a trailing \r (see email-reports memory).
  const expected = (secret ?? '').trim();
  if (expected.length < 16 || typeof presented !== 'string') return false;
  const a = Buffer.from(presented.trim());
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
