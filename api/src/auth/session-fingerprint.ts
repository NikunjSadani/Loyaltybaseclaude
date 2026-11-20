import * as crypto from 'crypto';

/**
 * S-H1(a) / M-2 / M1 / L5 — a STABLE, version-free device-class fingerprint of the BROWSER behind a refresh.
 *
 * Coarse on purpose: browser FAMILY + OS GROUP — never version numbers, and never the mobile flag:
 *  - a Chrome / iOS / Android update does not change it (an update must not log anyone out);
 *  - the "Request desktop site" toggle (Android Chrome reports Linux/X11 and drops "Mobile"; iPad/iPhone Safari
 *    reports Macintosh) does not change it either: android↔linux and ios↔macos are one OS GROUP each (L5).
 *
 * Only a REAL browser User-Agent produces a fingerprint. A non-browser UA (Node / undici — i.e. our own Next server
 * when the internal secret is missing or wrong — curl, scripts) yields null = UNKNOWN: an unknown fingerprint is never
 * handed a session and never counts as a mismatch (no alarm, no lineage end). See AuthService.handbackUnusedSuccessor.
 *
 * Stored values carry a version prefix (`v3:`); any stored value without it (written before this scheme) is UNKNOWN
 * on comparison — never a mismatch.
 *
 * This narrows a handback to "the same kind of device": it is NOT an identity. Anyone using the same browser family
 * on the same OS group produces the same value — see the residual-risk notes in P1-sessions-design.md.
 */
export const FINGERPRINT_VERSION = 'v3';

export function sessionFingerprint(input: { userAgent?: string | null; platform?: string | null; mobile?: string | null }): string | null {
  const ua = (input.userAgent ?? '').trim();
  if (!looksLikeBrowser(ua)) return null;
  const { browser, osGroup } = deviceClass(ua);
  if (browser === 'other' || osGroup === 'other') return null;
  const hash = crypto.createHash('sha256').update(`${FINGERPRINT_VERSION}|${browser}|${osGroup}`).digest('hex');
  return `${FINGERPRINT_VERSION}:${hash}`;
}

/** A stored / presented fingerprint is usable for comparison only if it is a current-scheme browser fingerprint. */
export function isKnownFingerprint(fp: string | null | undefined): fp is string {
  return typeof fp === 'string' && fp.startsWith(`${FINGERPRINT_VERSION}:`);
}

/** Real browsers all send "Mozilla/5.0 (" … ; Node's fetch ("node" / "undici"), curl, scripts do not. */
export function looksLikeBrowser(ua: string): boolean {
  return /^Mozilla\/5\.0 \(/.test(ua);
}

/** Exposed for tests / diagnostics: the version-free device class a fingerprint is built from. */
export function deviceClass(ua: string): { browser: string; os: string; osGroup: string } {
  const browser =
    /\bEdgA?\//.test(ua) || /\bEdg(iOS)?\//.test(ua) ? 'edge'
      : /\bOPR\/|\bOpera\b/.test(ua) ? 'opera'
        : /\bSamsungBrowser\//.test(ua) ? 'samsung'
          : /\bFxiOS\//.test(ua) || /\bFirefox\//.test(ua) ? 'firefox'
            : /\bCriOS\//.test(ua) || /\bChrome\//.test(ua) || /\bChromium\//.test(ua) ? 'chrome'
              : /\bSafari\//.test(ua) ? 'safari'
                : 'other';
  const os =
    /\bAndroid\b/.test(ua) ? 'android'
      : /\b(iPhone|iPad|iPod)\b/.test(ua) ? 'ios'
        : /\bCrOS\b/.test(ua) ? 'chromeos'
          : /\bWindows\b/.test(ua) ? 'windows'
            : /\bMac OS X\b|\bMacintosh\b/.test(ua) ? 'macos'
              : /\bLinux\b|\bX11\b/.test(ua) ? 'linux'
                : 'other';
  // L5 — "desktop site" toggles flip android→linux and ios→macos: one group each.
  const osGroup = os === 'android' || os === 'linux' ? 'android-linux' : os === 'ios' || os === 'macos' ? 'apple' : os;
  return { browser, os, osGroup };
}
