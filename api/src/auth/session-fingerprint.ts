import * as crypto from 'crypto';

/**
 * S-H1(a) / M-2 — a STABLE device-class fingerprint of the client that made a refresh request.
 *
 * Deliberately coarse: browser FAMILY + OS FAMILY + mobile flag — never version numbers — so a Chrome / iOS /
 * Android update between a rotation and the replay does NOT change it (a browser update must not log anyone
 * out). The browser's values reach the API as `x-client-user-agent` / `x-client-ua-platform` /
 * `x-client-ua-mobile` (forwarded by our Next server and only trusted with the internal secret — see
 * common/internal-call.ts); a direct caller is fingerprinted from its own User-Agent.
 *
 * Returns null (UNKNOWN) when there is no User-Agent at all: an unknown fingerprint is never handed a session
 * and never triggers a kill (see AuthService.handbackUnusedSuccessor).
 *
 * This narrows a handback to "the same kind of device": it is NOT an identity. Anyone using the same browser
 * family on the same OS family produces the same value — see the residual-risk notes in P1-sessions-design.md.
 */
export function sessionFingerprint(input: {
  userAgent?: string | null;
  platform?: string | null;
  mobile?: string | null;
}): string | null {
  const ua = (input.userAgent ?? '').trim();
  if (!ua) return null;
  const { browser, os, mobile } = deviceClass(ua, input.mobile);
  return crypto.createHash('sha256').update(`v2|${browser}|${os}|${mobile ? 1 : 0}`).digest('hex');
}

/** Exposed for tests / diagnostics: the version-free device class a fingerprint is built from. */
export function deviceClass(ua: string, mobileHint?: string | null): { browser: string; os: string; mobile: boolean } {
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
              : /\bLinux\b/.test(ua) ? 'linux'
                : 'other';
  const hint = (mobileHint ?? '').trim();
  const mobile = hint === '?1' ? true : hint === '?0' ? false : /\bMobile\b|\bAndroid\b|\biPhone\b|\biPod\b/.test(ua);
  return { browser, os, mobile };
}
