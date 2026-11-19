/**
 * location-gate.ts — "no location, no use" for sales-rep KYC + visibility capture (owner-approved 2026-11-18;
 * docs/plans/LOCATION-GATE.md). Pure helpers, no React:
 *
 *   • checkLocation()          — is location usable RIGHT NOW? permission (Permissions API where the browser has it)
 *                                AND a real GPS fix arriving. Never rejects.
 *   • detectLocationPlatform() — which phone/browser guide to show.
 *   • locationGuide()          — the honest, platform-specific recovery steps for a block reason.
 *
 * What a browser can and cannot tell us (stated honestly in the guide): it cannot read the phone's GPS/Location
 * switch. "Location off" only shows up as no fix — POSITION_UNAVAILABLE or TIMEOUT. Permission state comes from the
 * Permissions API where available (older Safari lacks it → we rely on the request's own result).
 *
 * No network request is made here (geolocation is on-device), so nothing needs the X-Background tag.
 * Used ONLY when the tenant's `features.requireLocation` is ON — Deoleo / every other tenant never calls it.
 */

export type LocationBlockReason = 'unsupported' | 'insecure' | 'denied' | 'unavailable' | 'timeout';

export interface LocationFix {
  lat: number;
  lng: number;
  /** Reported accuracy in metres (rounded). */
  accuracy: number;
}

export type LocationCheckResult =
  | { ok: true; fix: LocationFix }
  | { ok: false; reason: LocationBlockReason };

/** How long a check waits for a fix before calling it "no fix" (a cold GPS start outdoors is usually < 15 s). */
export const LOCATION_CHECK_TIMEOUT_MS = 20_000;
/** A fix this recent (ms) from the browser's cache is still a real fix from this phone — accepted. */
export const LOCATION_CHECK_MAX_AGE_MS = 30_000;

type PermissionStateOrUnknown = PermissionState | 'unknown';

/** The site's geolocation permission via the Permissions API, or 'unknown' where the browser has none. */
export async function readLocationPermission(): Promise<PermissionStateOrUnknown> {
  try {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown';
    const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return status?.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const validFix = (c: GeolocationCoordinates | undefined): boolean =>
  !!c &&
  Number.isFinite(c.latitude) &&
  Number.isFinite(c.longitude) &&
  Math.abs(c.latitude) <= 90 &&
  Math.abs(c.longitude) <= 180;

/**
 * Check that location is usable now: allowed for the site AND a real fix arrives. Never rejects, never hangs
 * (bounded by `timeoutMs` plus a small guard for browsers that never call back).
 */
export async function checkLocation(
  opts: { timeoutMs?: number; maximumAgeMs?: number } = {},
): Promise<LocationCheckResult> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return { ok: false, reason: 'unsupported' };
  if (typeof window !== 'undefined' && window.isSecureContext === false) return { ok: false, reason: 'insecure' };

  // Permissions API: a definite "denied" means the browser will not even ask — skip the request.
  const permission = await readLocationPermission();
  if (permission === 'denied') return { ok: false, reason: 'denied' };

  const timeoutMs = opts.timeoutMs ?? LOCATION_CHECK_TIMEOUT_MS;
  return new Promise<LocationCheckResult>((resolve) => {
    let settled = false;
    const done = (r: LocationCheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(r);
    };
    // Some browsers never call back while the permission prompt is ignored — don't hang the rep forever.
    const guard = setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs + 5_000);
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (!validFix(pos?.coords)) return done({ ok: false, reason: 'unavailable' });
          done({
            ok: true,
            fix: {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: Math.round(pos.coords.accuracy),
            },
          });
        },
        (err) => {
          // 1 PERMISSION_DENIED · 2 POSITION_UNAVAILABLE · 3 TIMEOUT (numeric — the constants are not on every error object).
          const reason: LocationBlockReason = err?.code === 1 ? 'denied' : err?.code === 3 ? 'timeout' : 'unavailable';
          done({ ok: false, reason });
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: opts.maximumAgeMs ?? LOCATION_CHECK_MAX_AGE_MS },
      );
    } catch {
      done({ ok: false, reason: 'unavailable' });
    }
  });
}

// ─── Which guide ──────────────────────────────────────────────────────────────

export type LocationPlatform = 'android' | 'ios-safari' | 'ios-app' | 'desktop';

/** Pick the guide from the user agent + whether the page runs as an installed (home-screen) app. */
export function detectLocationPlatform(userAgent: string, standalone: boolean): LocationPlatform {
  const ua = userAgent || '';
  // iPadOS asking for the desktop site reports "Macintosh" but has touch — treat as iOS.
  const iPadDesktop = /Macintosh/.test(ua) && typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 1;
  if (/iPhone|iPad|iPod/.test(ua) || iPadDesktop) return standalone ? 'ios-app' : 'ios-safari';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

/** The current page's platform (browser only). */
export function currentLocationPlatform(): LocationPlatform {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return 'desktop';
  let standalone = false;
  try {
    standalone =
      window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    standalone = false;
  }
  return detectLocationPlatform(navigator.userAgent, standalone);
}

// ─── What to tell the rep ─────────────────────────────────────────────────────

export interface LocationGuide {
  title: string;
  intro: string;
  steps: string[];
  /** Shown under the steps — the honest limit of what the page can detect. */
  footnote?: string;
}

const NO_FIX_FOOTNOTE =
  "Your browser can't tell us whether the phone's Location switch is on — it only tells us that no location arrived. If you've allowed location and still see this, the phone couldn't get a fix yet.";

export function locationGuide(platform: LocationPlatform, reason: LocationBlockReason): LocationGuide {
  if (reason === 'unsupported') {
    return {
      title: "This browser can't share your location",
      intro: 'Location is needed here, but this browser does not offer it.',
      steps: [
        platform === 'android'
          ? 'Open this site in Google Chrome.'
          : platform === 'ios-safari' || platform === 'ios-app'
            ? 'Open this site in Safari.'
            : 'Open this site in Chrome, Edge, Safari or Firefox.',
        'Sign in again and tap Test again.',
      ],
    };
  }
  if (reason === 'insecure') {
    return {
      title: 'Location needs the secure address',
      intro: 'Browsers only share location with sites opened over https://.',
      steps: ['Open the app from its usual https:// link or the installed app icon.', 'Then tap Test again.'],
    };
  }

  if (reason === 'denied') {
    switch (platform) {
      case 'android':
        return {
          title: 'Location is blocked for this site',
          intro: 'Allow location for this site in Chrome, then tap Test again.',
          steps: [
            'Tap the icon at the left of the address bar (it looks like ⓘ or two sliders), then Permissions → Location → Allow.',
            'Or: Chrome menu ⋮ → Settings → Site settings → Location → find this site → Allow.',
            "Using the installed app? It uses Chrome's setting for this site — change it in Chrome as above, then reopen the app.",
            'Make sure the phone’s own Location is on too: pull down from the top of the screen and turn on Location.',
          ],
        };
      case 'ios-safari':
        return {
          title: 'Location is blocked for Safari',
          intro: 'Allow location for Safari websites, then tap Test again.',
          steps: [
            'Open the Settings app → Privacy & Security → Location Services, and make sure Location Services is On.',
            'In the same list, tap Safari Websites → choose “While Using the App” (or “Ask Next Time”), and turn on Precise Location.',
            'Back in Safari, tap “aA” in the address bar → Website Settings → Location → Allow.',
            'Return here and tap Test again.',
          ],
        };
      case 'ios-app':
        return {
          title: 'Location is blocked for the app',
          intro: 'The home-screen app uses Safari’s location setting.',
          steps: [
            'Open the Settings app → Privacy & Security → Location Services, and make sure it is On.',
            'In the same list, tap Safari Websites → choose “While Using the App”, and turn on Precise Location.',
            'Close the app completely (swipe it away from the app switcher) and open it again from the home screen.',
            'If it still says blocked, open this site in Safari once, allow location when asked, then reopen the app.',
          ],
        };
      default:
        return {
          title: 'Location is blocked for this site',
          intro: 'Allow location for this site in your browser, then tap Test again.',
          steps: [
            'Click the icon at the left of the address bar (a padlock or sliders) → Location → Allow, then reload the page.',
            'Windows: Settings → Privacy & security → Location → turn on “Location services” and allow your browser.',
            'Mac: System Settings → Privacy & Security → Location Services → turn on your browser.',
          ],
        };
    }
  }

  // 'unavailable' | 'timeout' — allowed (or not yet asked), but no fix arrived: usually the phone's Location is
  // off, or there's no signal.
  const slow = reason === 'timeout';
  switch (platform) {
    case 'android':
      return {
        title: slow ? 'Getting your location is taking too long' : "Couldn't get your location",
        intro: 'Turn on the phone’s Location, then tap Test again.',
        steps: [
          'Pull down from the top of the screen and turn on Location.',
          'Settings → Location → Location services → Google Location Accuracy → turn it On (this makes the fix faster).',
          'Step outside or near a window — GPS needs a view of the sky.',
          'If Chrome asks to allow location for this site, tap Allow.',
        ],
        footnote: NO_FIX_FOOTNOTE,
      };
    case 'ios-safari':
    case 'ios-app':
      return {
        title: slow ? 'Getting your location is taking too long' : "Couldn't get your location",
        intro: 'Turn on Location Services, then tap Test again.',
        steps: [
          'Open the Settings app → Privacy & Security → Location Services → make sure it is On.',
          'In the same list, tap Safari Websites → “While Using the App”, and turn on Precise Location.',
          'Step outside or near a window — GPS needs a view of the sky.',
          'If Safari asks to allow location for this site, tap Allow.',
        ],
        footnote: NO_FIX_FOOTNOTE,
      };
    default:
      return {
        title: slow ? 'Getting your location is taking too long' : "Couldn't get your location",
        intro: 'Turn on location for this device, then tap Test again.',
        steps: [
          'Windows: Settings → Privacy & security → Location → turn on “Location services”. Mac: System Settings → Privacy & Security → Location Services.',
          'Keep Wi-Fi on — computers without GPS find their location through Wi-Fi.',
          'Field work is best done on a phone with GPS.',
        ],
        footnote: NO_FIX_FOOTNOTE,
      };
  }
}
