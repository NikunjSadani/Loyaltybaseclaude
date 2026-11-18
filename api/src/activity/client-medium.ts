/**
 * Usage Report — HOW a request reached us (docs/plans/USAGE-REPORT.md).
 *
 *  • medium  — 'app' (the installed PWA, display-mode standalone) | 'browser' (a normal tab), read from the
 *              `X-Client-Medium` header the platform frontend adds to every same-origin /api call
 *              (platform/src/lib/client-medium.ts). The header is UNTRUSTED client input: anything other than
 *              exactly 'app' / 'browser' (case/whitespace-insensitive) is 'unknown' and records nothing.
 *  • device  — 'phone' | 'computer', derived from the User-Agent with a deliberately simple rule:
 *              phone    = Android / iPhone / iPad / iPod / "Mobi" / other mobile markers (tablets count as phones);
 *              computer = Windows / Macintosh / X11 / Linux / ChromeOS without a mobile marker;
 *              unknown  = empty or anything else (server-to-server calls, scripts).
 *              Known limit: iPadOS Safari asks for the DESKTOP site by default, so an iPad reports "Macintosh"
 *              and is counted as a computer.
 *
 * Pure, never throws.
 */

export type ClientMedium = 'app' | 'browser' | 'unknown';
export type DeviceKind = 'phone' | 'computer' | 'unknown';

export interface ActivityContext {
  medium: ClientMedium;
  device: DeviceKind;
}

/** The request header the platform sets (HTTP headers are case-insensitive; Node lower-cases them). */
export const CLIENT_MEDIUM_HEADER = 'x-client-medium';

export const UNKNOWN_ACTIVITY_CONTEXT: ActivityContext = Object.freeze({ medium: 'unknown', device: 'unknown' });

/** Validate the untrusted header to one of the two known values; everything else → 'unknown'. */
export function parseClientMedium(raw: unknown): ClientMedium {
  // A repeated header arrives as an array (or a comma-joined string) — ambiguous → unknown.
  if (typeof raw !== 'string') return 'unknown';
  const v = raw.trim().toLowerCase();
  if (v === 'app' || v === 'browser') return v;
  return 'unknown';
}

const PHONE_RE = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|IEMobile|BlackBerry|BB10|Opera Mini|webOS|KaiOS/i;
const COMPUTER_RE = /Windows NT|Windows|Macintosh|Mac OS X|X11|Linux|CrOS/i;

/** Phone vs computer from a User-Agent string (see the module note for the exact rule). */
export function deviceFromUserAgent(raw: unknown): DeviceKind {
  if (typeof raw !== 'string') return 'unknown';
  const ua = raw.slice(0, 1024);
  if (!ua.trim()) return 'unknown';
  // Order matters: Android UAs also say "Linux".
  if (PHONE_RE.test(ua)) return 'phone';
  if (COMPUTER_RE.test(ua)) return 'computer';
  return 'unknown';
}

type HeaderBag = Record<string, string | string[] | undefined>;

/** Medium + device from an Express-style request. Never throws (a missing/odd request → unknown/unknown). */
export function activityContextFromRequest(req: unknown): ActivityContext {
  try {
    const headers = (req as { headers?: HeaderBag } | null | undefined)?.headers;
    if (!headers || typeof headers !== 'object') return UNKNOWN_ACTIVITY_CONTEXT;
    return {
      medium: parseClientMedium(headers[CLIENT_MEDIUM_HEADER]),
      device: deviceFromUserAgent(headers['user-agent']),
    };
  } catch {
    return UNKNOWN_ACTIVITY_CONTEXT;
  }
}
