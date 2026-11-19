/**
 * notification-guide.ts — what the Bajaj "turn on notifications" reminder (and the Profile → Notifications card when
 * blocked) tells the user, by permission state and device (owner decision 2026-11-19; PWA-PLAN.md § Notification
 * reminder). Pure, no React. Wording matches the Bajaj training deck's notification steps.
 *
 * Device detection is NOT re-implemented here — callers pass the platform from the location gate's
 * `currentLocationPlatform()` ('android' | 'ios-safari' | 'ios-app' | 'desktop'). The only UA reads here are the iOS
 * version (Web Push on iPhone needs iOS 16.4+, and only in the app opened from the Home Screen) and which Android
 * browser it is (Chrome / Samsung Internet / other — their settings menus differ).
 *
 * Used ONLY for the Bajaj tenant — every other tenant keeps the original bar / generic sentence.
 */
import type { LocationPlatform } from '@/lib/location-gate';

export type NotificationPlatform = LocationPlatform;

/** What the browser can tell us about notifications right now. */
export type NotificationState = NotificationPermission | 'unsupported';

/** Which Android browser — Chrome and Samsung Internet have different settings menus. */
export type AndroidBrowser = 'chrome' | 'samsung' | 'other';

export type NotificationGuideKind =
  | 'enable' // permission 'default' and the page can ask → Enable button
  | 'install-first' // iPhone in a browser tab → add to Home Screen first, no Enable button
  | 'ios-too-old' // iPhone below iOS 16.4 → one plain line
  | 'blocked' // permission 'denied' → device steps + "Done — check again"
  | 'unsupported'; // no Push API here → one plain line

export interface NotificationGuide {
  kind: NotificationGuideKind;
  title: string;
  /** One plain sentence under the title. For 'ios-too-old' / 'unsupported' this is the whole message. */
  intro: string;
  /** Numbered steps (empty for the one-line kinds). */
  steps: string[];
  footnote?: string;
}

export interface NotificationGuideInput {
  platform: NotificationPlatform;
  state: NotificationState;
  /** Parsed iOS version, or null when unknown / not iOS. */
  iosVersion: { major: number; minor: number } | null;
  /** True when an iPhone/iPad browser tab is real Safari. */
  inSafari?: boolean;
  /** Which Android browser (ignored off Android). Defaults to Chrome. */
  androidBrowser?: AndroidBrowser;
  /** The site host shown in the browser's site-settings list (e.g. bajaj.gifsy.in). */
  host?: string;
  /**
   * The app's name as it appears in phone Settings — the install manifest's name (`pwaAppName()`), e.g.
   * "Bajaj Consumer Care Ltd" (/partner) or "Bajaj Consumer Care Ltd Sales" (/sales). Callers pass it; never hard-coded.
   */
  appName?: string;
}

/** Web Push on iPhone/iPad arrived in iOS / iPadOS 16.4. */
export const MIN_IOS_PUSH = { major: 16, minor: 4 } as const;

/**
 * The iOS version from a user agent, or null when it can't be read. iPhone/iPad UAs carry "OS 16_3"; an iPad asking
 * for the desktop site reports "Macintosh … Version/16.3", so that is the fallback (absent in some Home Screen apps →
 * null = unknown, never treated as "too old").
 */
export function parseIosVersion(userAgent: string): { major: number; minor: number } | null {
  const ua = userAgent || '';
  const m = /\bOS (\d+)[_.](\d+)/.exec(ua) ?? /Version\/(\d+)\.(\d+)/.exec(ua);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  return { major, minor };
}

/** Chrome vs Samsung Internet vs any other Android browser (Firefox, Edge, Opera, Mi, in-app WebViews…). */
export function detectAndroidBrowser(userAgent: string): AndroidBrowser {
  const ua = userAgent || '';
  if (/SamsungBrowser\//.test(ua)) return 'samsung';
  // Chromium forks and WebViews also carry "Chrome/" — exclude them so only real Chrome gets Chrome's menu path.
  const fork = /EdgA\/|OPR\/|Opera|YaBrowser\/|UCBrowser\/|MiuiBrowser\/|HeyTapBrowser\/|VivoBrowser\/|Brave|DuckDuckGo\/|; wv\)/.test(ua);
  if (/Chrome\/\d/.test(ua) && !fork) return 'chrome';
  return 'other';
}

export function iosTooOld(v: { major: number; minor: number } | null): boolean {
  if (!v) return false; // unknown → don't claim it's too old
  return v.major < MIN_IOS_PUSH.major || (v.major === MIN_IOS_PUSH.major && v.minor < MIN_IOS_PUSH.minor);
}

const isIos = (p: NotificationPlatform) => p === 'ios-safari' || p === 'ios-app';

const IOS_TOO_OLD: NotificationGuide = {
  kind: 'ios-too-old',
  title: 'Notifications need a newer iPhone update',
  intro: 'Notifications need iOS 16.4 or later. Update your iPhone in Settings → General → Software Update.',
  steps: [],
};

/** "Chrome" / "Samsung Internet" / "your browser" — for the prompts the user will see. */
export function browserLabel(platform: NotificationPlatform, androidBrowser: AndroidBrowser = 'chrome'): string {
  if (platform !== 'android') return 'your browser';
  return androidBrowser === 'chrome' ? 'Chrome' : androidBrowser === 'samsung' ? 'Samsung Internet' : 'your browser';
}

/**
 * Steps to re-enable after "Block" / "Don't Allow" (the app can no longer ask). None of them depend on this reminder
 * re-appearing: once allowed, the next app open turns notifications on by itself (the granted re-sync).
 */
export function blockedSteps(
  platform: NotificationPlatform,
  host = 'this site',
  appName = 'the app',
  androidBrowser: AndroidBrowser = 'chrome',
): string[] {
  switch (platform) {
    case 'android': {
      const after = 'Come back to the app and tap “Done — check again”. (If the app restarts, notifications turn on by themselves.)';
      const phone = (browser: string) =>
        `Still nothing? Open the phone Settings → Apps → ${appName} (or ${browser}) → Notifications → turn ON.`;
      const dnd = 'Make sure Do Not Disturb is off.';
      if (androidBrowser === 'samsung') {
        return [
          'Open Samsung Internet and tap ≡ (menu) → Settings → Sites and downloads (or Site permissions) → Notifications.',
          `Find ${host} and allow it.`,
          after,
          phone('Samsung Internet'),
          dnd,
        ];
      }
      if (androidBrowser === 'other') {
        return [
          'Open your browser’s site settings → Notifications.',
          `Find ${host} and allow it.`,
          after,
          phone('your browser'),
          dnd,
        ];
      }
      return [
        'Open Chrome and tap ⋮ (top right) → Settings → Site settings → Notifications.',
        `Under Blocked, tap ${host} → Allow.`,
        after,
        phone('Chrome'),
        dnd,
      ];
    }
    case 'ios-app':
    case 'ios-safari':
      return [
        'Open the iPhone Settings app → Notifications.',
        `Tap ${appName} in the list and turn on Allow Notifications.`,
        'Close the app fully (swipe it away) and open it again from the Home Screen — notifications then turn on by themselves.',
      ];
    default:
      return [
        'Click the icon at the left of the address bar (a padlock or sliders) → Notifications → Allow.',
        'Then click “Done — check again”. (Reloaded the page? Notifications turn on by themselves once allowed.)',
      ];
  }
}

/** Pick what to show. Returns null when nothing should be shown (notifications are already allowed). */
export function notificationGuide(input: NotificationGuideInput): NotificationGuide | null {
  const { platform, state, iosVersion } = input;
  const androidBrowser = input.androidBrowser ?? 'chrome';
  const appName = input.appName?.trim() ? `the ${input.appName.trim()} app` : 'the app';

  if (state === 'granted') return null;

  // iPhone/iPad: below 16.4 there is no Web Push at all, in Safari or in the Home Screen app.
  if (isIos(platform) && iosTooOld(iosVersion)) return IOS_TOO_OLD;

  // iPhone in a browser tab: push can only work in the Home Screen app — never offer Enable here
  // (browser tabs don't even expose the Notification API).
  if (platform === 'ios-safari') {
    const share =
      input.inSafari === false
        ? 'Tap Share — in Chrome it’s in the address bar or under •••. (No “Add to Home Screen” there? Open this page in Safari and do it there.)'
        : 'In Safari, tap Share (the square with an arrow) — or tap ••• and then Share.';
    return {
      kind: 'install-first',
      title: 'Add the app to your Home Screen first',
      intro: 'On iPhone, notifications only work in the app opened from your Home Screen — not in a browser tab.',
      steps: [
        share,
        'Tap “Add to Home Screen”, then Add.',
        'Open the app from the new Home Screen icon and sign in.',
        'Tap Enable on the notifications reminder, then Allow.',
      ],
      footnote: 'Needs iOS 16.4 or later.',
    };
  }

  if (state === 'unsupported') {
    if (platform === 'ios-app') {
      // A Home Screen app without Web Push: the version is unknown (iPad desktop-mode UA) or ≥ 16.4 — don't claim
      // "can't show notifications"; say what's needed, neutrally.
      return {
        kind: 'unsupported',
        title: 'Notifications aren’t available yet',
        intro:
          'Notifications need iOS / iPadOS 16.4 or later. If you’re up to date, close the app fully and open it again from the Home Screen.',
        steps: [],
      };
    }
    return {
      kind: 'unsupported',
      title: 'Notifications aren’t available here',
      intro:
        platform === 'android'
          ? 'This browser can’t show notifications — open the app in Google Chrome to get them.'
          : 'This browser can’t show notifications.',
      steps: [],
    };
  }

  if (state === 'denied') {
    return {
      kind: 'blocked',
      title: 'Notifications are blocked',
      intro: 'The app can’t ask again. Turn them back on with these steps:',
      steps: blockedSteps(platform, input.host || 'this site', appName, androidBrowser),
    };
  }

  // 'default' — the page can still ask (Android, desktop, iPhone Home Screen app).
  return {
    kind: 'enable',
    title: 'Turn on notifications',
    intro: 'Get timely updates on your phone, even when the app is closed.',
    steps: [
      'Tap “Enable notifications” below.',
      platform === 'android'
        ? androidBrowser === 'chrome'
          ? 'When Chrome asks “… wants to show notifications”, tap Allow.'
          : `When ${browserLabel(platform, androidBrowser)} asks to show notifications, tap Allow.`
        : platform === 'ios-app'
          ? 'When the iPhone asks, tap Allow.'
          : 'When the browser asks, click Allow.',
    ],
    footnote: 'Missed it? You can always turn them on from Profile → Notifications.',
  };
}
