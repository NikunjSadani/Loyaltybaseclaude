import * as crypto from 'crypto';

/**
 * S-H1(a) device fingerprint of the CLIENT that made a refresh request.
 *
 * Refreshes reach the API server-to-server from the Next proxy / route handler, so the request's own
 * User-Agent is Node's. The Next side forwards the browser's values as `x-client-user-agent`,
 * `x-client-ua-platform` and `x-client-ua-mobile`; a direct API caller (no Next in front) falls back to its
 * own User-Agent. Returns null when there is no User-Agent at all — a null fingerprint NEVER matches,
 * so such a request can never be handed back a session.
 *
 * This is a "same device class / browser build" signal, not an identity: anyone who copies the victim's
 * headers can reproduce it. It narrows the never-used-successor handback to the device that lost the
 * response; it is not a substitute for reuse detection.
 */
export function sessionFingerprint(input: {
  userAgent?: string | null;
  platform?: string | null;
  mobile?: string | null;
}): string | null {
  const ua = (input.userAgent ?? '').trim();
  if (!ua) return null;
  const platform = (input.platform ?? '').trim().toLowerCase();
  const mobile = (input.mobile ?? '').trim().toLowerCase();
  return crypto.createHash('sha256').update(`${ua}\n${platform}\n${mobile}`).digest('hex');
}
