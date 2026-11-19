/**
 * notification-guide.ts — what the Bajaj "turn on notifications" reminder (and the Profile → Notifications card when
 * blocked) tells the user, by permission state and device (owner decision 2026-11-19; PWA-PLAN.md § Notification
 * reminder). Pure, no React. Wording matches the Bajaj training deck's notification steps.
 *
 * Device detection is NOT re-implemented here — callers pass the platform from the location gate's
 * `currentLocationPlatform()` ('android' | 'ios-safari' | 'ios-app' | 'desktop'). The only UA read here is the iOS
 * version (Web Push on iPhone needs iOS 16.4+, and only in the app opened from the Home Screen).
 *
 * Used ONLY for the Bajaj tenant — every other tenant keeps the original bar / generic sentence.
 */
import type { LocationPlatform } from '@/lib/location-gate';

export type NotificationPlatform = LocationPlatform;

/** What the browser can tell us about notifications right now. */
export type NotificationState = NotificationPermission | 'unsupported';

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
  /** True when an iPhone/iPad browser tab is real Safari (Add to Home Screen lives there). */
  inSafari?: boolean;
  /** The site host shown in Chrome's Site settings list (e.g. bajaj.gifsy.in). */
  host?: string;
  /** The app's name as it appears in phone Settings (e.g. "Bajaj"). */
  appName?: string;
}

/** Web Push on iPhone/iPad arrived in iOS / iPadOS 16.4. */
export const MIN_IOS_PUSH = { major: 16, minor: 4 } as const;

/**
 * The iOS version from a user agent, or null when it can't be read. iPhone/iPad UAs carry "OS 16_3"; an iPad asking
 * for the desktop site reports "Macintosh … Version/16.3", so that is the fallback.
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

/** Steps to re-enable after "Block" / "Don't Allow" (the app can no longer ask). */
export function blockedSteps(platform: NotificationPlatform, host = 'this site', appName = 'the app'): string[] {
  switch (platform) {
    case 'android':
      return [
        'Open Chrome and tap ⋮ (top right) → Settings → Site settings → Notifications.',
        `Under Blocked, tap ${host} → Allow.`,
        'Reopen the app, then tap “Done — check again”.',
        `Still nothing? Open the phone Settings → Apps → ${appName} (or Chrome) → Notifications → turn ON.`,
        'Make sure Do Not Disturb is off.',
      ];
    case 'ios-app':
    case 'ios-safari':
      return [
        'Open the iPhone Settings app → Notifications.',
        `Tap ${appName} in the list and turn on Allow Notifications.`,
        'Close the app fully (swipe it away), open it again from the Home Screen, then tap “Done — check again”.',
      ];
    default:
      return [
        'Click the icon at the left of the address bar (a padlock or sliders) → Notifications → Allow.',
        'Reload the page, then tap “Done — check again”.',
      ];
  }
}

/** Pick what to show. Returns null when nothing should be shown (notifications are already allowed). */
export function notificationGuide(input: NotificationGuideInput): NotificationGuide | null {
  const { platform, state, iosVersion } = input;
  const appName = input.appName?.trim() ? `the ${input.appName.trim()} app` : 'the app';

  if (state === 'granted') return null;

  // iPhone/iPad: below 16.4 there is no Web Push at all, in Safari or in the Home Screen app.
  if (isIos(platform) && iosTooOld(iosVersion)) return IOS_TOO_OLD;

  // iPhone in a browser tab: push can only work in the Home Screen app — never offer Enable here
  // (Safari tabs don't even expose the Notification API).
  if (platform === 'ios-safari') {
    return {
      kind: 'install-first',
      title: 'Add the app to your Home Screen first',
      intro: 'On iPhone, notifications only work in the app opened from your Home Screen — not in a browser tab.',
      steps: [
        ...(input.inSafari === false ? ['Open this page in Safari.'] : []),
        'In Safari, tap Share (the square with an arrow) — or tap ••• and then Share.',
        'Tap “Add to Home Screen”, then Add.',
        'Open the app from the new Home Screen icon and sign in.',
        'Tap Enable on the notifications reminder, then Allow.',
      ],
      footnote: 'Needs iOS 16.4 or later.',
    };
  }

  if (state === 'unsupported') {
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
      steps: blockedSteps(platform, input.host || 'this site', appName),
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
        ? 'When Chrome asks “… wants to show notifications”, tap Allow.'
        : platform === 'ios-app'
          ? 'When the iPhone asks, tap Allow.'
          : 'When the browser asks, click Allow.',
    ],
    footnote: 'Missed it? You can always turn them on from Profile → Notifications.',
  };
}
