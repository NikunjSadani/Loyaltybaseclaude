'use client';

// -----------------------------------------------------------------------------
// PushSubscriptionManager — PWA phase F5 (Web Push subscribe UX). SHIPPED DISABLED.
//
// Drop-in client component the root layout mounts. INERT (renders null) unless
// ALL of:
//   1. NEXT_PUBLIC_PWA_PUSH_ENABLED === 'true'  (default/unset = OFF, so it can't
//      surprise UAT testers; flip ON once push delivery is wired end-to-end)
//   2. the current path starts with /sales or /partner (push scope)
//   3. the browser supports service workers AND the Push API
//
// Behaviour (best-practice: only ever request permission from a user gesture):
//   • Notification.permission === 'granted' => silently re-sync the subscription
//     once (subscribeToPush is idempotent; the backend upserts). Renders null.
//   • 'denied' => render null (never re-prompt).
//   • 'default' and not recently snoozed => show a small non-intrusive
//     "Enable notifications" prompt. Enable => requestPermission() (gesture) then
//     subscribe on grant. Not now => SNOOZE for 3 days (not permanent), and the
//     Profile page (PwaAppSettings) offers a persistent entry point.
//
// Self-contained: no toast/context dependency, matching ServiceWorkerRegister /
// InstallPrompt. Uses the global --brand-primary CSS var for the Enable button so
// it picks up the tenant colour.
//
// BAJAJ ONLY (owner 2026-11-19) — the bottom bar is replaced by NotificationReminder:
//   • only after the session is CONFIRMED live (GET /api/auth/me, background-tagged)
//     — a page about to bounce to login never shows it, never auto-asks, and never
//     uses up the "seen" flag;
//   • "seen" is recorded only after ≥ 3 s on screen or a dismiss / tap (so the SW's
//     first-claim reload at ~1 s doesn't use it up);
//   • shown once per session (sessionStorage, keyed to the CONFIRMED user id) whenever
//     notifications are NOT granted — default, denied, install-first (iPhone tab),
//     too-old iOS or unsupported — with device-specific steps;
//   • "Remind me later" / × / Escape hide it for the rest of the session; it comes
//     back on the next app open until notifications are allowed;
//   • the 3-day `pwa-push-snooze` is neither read nor written for Bajaj (it would
//     hide the reminder for 3 days, which conflicts with "every app open");
//   • the auto-request at load is kept on Android/desktop (raced with an 8 s timeout
//     so a quiet-UI / ignored prompt can't swallow the reminder) and skipped on
//     iPhone/iPad (iOS needs a tap — the reminder's Enable button);
//   • never opens while the InstallPrompt modal is on screen (no stacked modals).
// Every other tenant keeps the original bar + snooze below, byte-identical.
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { subscribeToPush } from '@/lib/pwa/push';
import { currentLocationPlatform } from '@/lib/location-gate';
import { isIosSafari } from '@/lib/pwa/platform-detect';
import { BACKGROUND_HEADER } from '@/lib/client-medium';
import { useInstallDialogOpen } from '@/lib/pwa/install-dialog-state';
import {
  detectAndroidBrowser,
  parseIosVersion,
  type AndroidBrowser,
  type NotificationState,
} from '@/lib/pwa/notification-guide';
import NotificationReminder from './NotificationReminder';

const SCOPED_PREFIXES = ['/sales', '/partner'];
const SNOOZE_KEY = 'pwa-push-snooze';
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
/** Bajaj reminder: set (to the confirmed user's id) once the reminder has been on screen this session. */
export const REMINDER_SESSION_KEY = 'pwa-notif-reminder';
/** The reminder must stay on screen this long before it counts as "seen" (unless dismissed / acted on sooner). */
export const REMINDER_SEEN_AFTER_MS = 3_000;
/** How long the automatic ask may stay unanswered (Chrome's quiet chip / an ignored bubble) before the reminder shows. */
export const AUTO_ASK_TIMEOUT_MS = 8_000;

/**
 * The CONFIRMED signed-in user's id from the live session (GET /api/auth/me — the proxy silently refreshes an expired
 * access token; /api/auth/* is excluded from SessionExpiryGuard's redirect). null = no live session (the page is
 * about to bounce to login) or the call failed → no reminder, no auto-ask. Background-tagged: not user activity.
 */
async function confirmedUserId(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/me', {
      credentials: 'include',
      headers: { Accept: 'application/json', [BACKGROUND_HEADER]: '1' },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { user?: { id?: unknown }; id?: unknown } } | null;
    const id = j?.data?.user?.id ?? j?.data?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  } catch {
    return null;
  }
}

/** True when this user already saw the reminder in this session (a different user signing in sees it again). */
function reminderSeenThisSession(userId: string): boolean {
  try {
    return sessionStorage.getItem(REMINDER_SESSION_KEY) === userId;
  } catch {
    return false;
  }
}

function markReminderSeen(userId: string) {
  try {
    sessionStorage.setItem(REMINDER_SESSION_KEY, userId);
  } catch {
    /* storage blocked — the reminder may show again on a full reload, never worse than that */
  }
}

interface ReminderSetup {
  userId: string;
  platform: ReturnType<typeof currentLocationPlatform>;
  state: NotificationState;
  iosVersion: ReturnType<typeof parseIosVersion>;
  inSafari: boolean;
  androidBrowser: AndroidBrowser;
  host: string;
}

function inScope(pathname: string): boolean {
  return SCOPED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** True when a snooze timestamp exists and is still within the snooze window. */
function isSnoozed(): boolean {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < SNOOZE_MS;
  } catch {
    return false;
  }
}

function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export default function PushSubscriptionManager({
  tenantSlug,
  appName,
}: {
  tenantSlug?: string;
  /**
   * The installed app's name exactly as the install manifest gives it (`pwaAppName()` — the manifest `name` /
   * `short_name`, e.g. "Bajaj Consumer Care Ltd" for /partner, "Bajaj Consumer Care Ltd Sales" for /sales), so the
   * phone-Settings steps name what the phone actually lists. Never hard-coded. Used only by the Bajaj reminder.
   */
  appName?: string;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [reminder, setReminder] = useState<ReminderSetup | null>(null);

  useEffect(() => {
    // Gate 1: the global flag OR the tenant being Bajaj. Flag read here (not at module
    // load) so Next inlines it the same way while staying test-stubbable. Other tenants
    // stay flag-only (default OFF) → byte-identical.
    const bajaj = (tenantSlug ?? '').trim().toLowerCase() === 'bajaj';
    if (!(process.env.NEXT_PUBLIC_PWA_PUSH_ENABLED === 'true' || bajaj)) return;
    if (typeof window === 'undefined') return;
    // Gate 2: only inside the /sales + /partner shells.
    if (!inScope(window.location.pathname)) return;

    if (bajaj) return runBajaj();

    // Gate 3: unsupported browser => no-op silently.
    if (!pushSupported() || typeof Notification === 'undefined') return;

    const permission = Notification.permission;

    if (permission === 'granted') {
      // Already granted: re-sync the subscription (idempotent). No UI. Automatic → background
      // (the Usage Report does not count it as activity).
      void subscribeToPush({ background: true });
      return;
    }

    if (permission === 'denied') {
      // Hard denial: never prompt.
      return;
    }

    // permission === 'default':
    if (isSnoozed()) return;

    // Non-Bajaj (flag on): offer the in-app opt-in banner (unchanged behaviour).
    setShowPrompt(true);

    // ── Bajaj: once-per-session reminder with device-specific steps ──────────────
    function runBajaj(): () => void {
      let cancelled = false;
      const supported = pushSupported() && typeof Notification !== 'undefined';
      const permission: NotificationState = supported ? Notification.permission : 'unsupported';

      if (permission === 'granted') {
        // Already granted: re-sync the subscription (idempotent). No UI.
        void subscribeToPush({ background: true });
        return () => { cancelled = true; };
      }

      void (async () => {
        // Only for a CONFIRMED live session — an expired one is about to bounce to login.
        const userId = await confirmedUserId();
        if (cancelled || !userId) return;
        // Already reminded this session ("Remind me later" = rest of the session) → no auto-ask, no reminder.
        if (reminderSeenThisSession(userId)) return;

        const platform = currentLocationPlatform();
        const ua = navigator.userAgent;
        const show = (state: NotificationState) => {
          if (cancelled) return;
          setReminder({
            userId,
            platform,
            state,
            iosVersion: parseIosVersion(ua),
            inSafari: isIosSafari(),
            androidBrowser: detectAndroidBrowser(ua),
            host: window.location.host,
          });
        };

        // Android / desktop with permission 'default' → ask AUTOMATICALLY first (Chromium shows the native prompt
        // without a gesture). NOT on iPhone/iPad: iOS only honours a request from a tap, so the reminder's Enable
        // button does it — no gesture-less request that could be refused on the user's behalf.
        const ios = platform === 'ios-safari' || platform === 'ios-app';
        if (permission !== 'default' || ios) {
          show(permission);
          return;
        }

        // Race the ask with a timeout: Chrome's quiet chip / an ignored bubble can leave it unresolved forever.
        const ask = Notification.requestPermission().catch(() => 'default' as NotificationPermission);
        const TIMED_OUT = Symbol('timeout');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          ask,
          new Promise<typeof TIMED_OUT>((r) => {
            timer = setTimeout(() => r(TIMED_OUT), AUTO_ASK_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
        if (cancelled) return;

        if (result === TIMED_OUT) {
          if (Notification.permission === 'granted') {
            await subscribeToPush({ background: true });
            return;
          }
          show(Notification.permission);
          // If the user answers the still-pending prompt later with Allow → subscribe and close the reminder.
          void ask.then(async (late) => {
            if (cancelled || (late !== 'granted' && Notification.permission !== 'granted')) return;
            await subscribeToPush();
            if (!cancelled) setReminder(null);
          });
          return;
        }

        // Re-read the REAL state: some browsers resolve 'denied' for an un-shown, gesture-less request.
        if (result === 'granted' || Notification.permission === 'granted') {
          // A subscribe failure must NOT surface the reminder (permission is granted) — the next load re-syncs,
          // and Profile → Notifications offers a manual retry.
          await subscribeToPush({ background: true });
          return;
        }
        show(Notification.permission);
      })();

      return () => { cancelled = true; };
    }
  }, [tenantSlug]);

  // "Seen this session" is written ONLY when the user has really had the reminder: it stayed on screen for
  // REMINDER_SEEN_AFTER_MS, or they dismissed / acted on it. Never at render time — on a brand-new session the
  // service worker's first `clients.claim()` used to make ServiceWorkerRegister reload the page ~1 s in (since
  // 2026-11-21 that first-install claim no longer reloads; update reloads still do); marking at render made the
  // reminder vanish for the whole session on exactly that first open. A dwell rule
  // is independent of the SW (it also survives a deploy-skew reload, a pull-to-refresh, or a SW that never claims),
  // whereas waiting for a "pending" claim can't be detected reliably on a first visit. Not counted while it waits
  // behind the install modal.
  const installOpen = useInstallDialogOpen();
  const reminderVisible = !!reminder && !installOpen;
  const reminderUser = reminder?.userId;
  useEffect(() => {
    if (!reminderVisible || !reminderUser) return;
    const t = setTimeout(() => markReminderSeen(reminderUser), REMINDER_SEEN_AFTER_MS);
    return () => clearTimeout(t);
  }, [reminderVisible, reminderUser]);

  const persistSnooze = () => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  };

  const enable = async () => {
    setShowPrompt(false);
    try {
      // Permission MUST be requested from this user gesture, never on load.
      const result = await Notification.requestPermission();
      if (result === 'granted') {
        await subscribeToPush();
      }
      // 'denied' / 'default': nothing more to do; SW handlers stay idle.
    } catch {
      /* requestPermission unsupported / rejected — fail silently */
    }
  };

  const dismiss = () => {
    setShowPrompt(false);
    persistSnooze();
  };

  if (reminder) {
    // Waits (renders nothing) while the InstallPrompt modal is on screen — never two aria-modal dialogs.
    if (installOpen) return null;
    return (
      <NotificationReminder
        platform={reminder.platform}
        initialState={reminder.state}
        iosVersion={reminder.iosVersion}
        inSafari={reminder.inSafari}
        androidBrowser={reminder.androidBrowser}
        host={reminder.host}
        appName={appName}
        onEngaged={() => markReminderSeen(reminder.userId)}
        onClose={() => {
          markReminderSeen(reminder.userId); // an explicit dismiss (or a finished Enable) = seen
          setReminder(null);
        }}
      />
    );
  }

  if (!showPrompt) return null;

  return (
    <div
      role="dialog"
      aria-label="Enable notifications"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '1rem',
        transform: 'translateX(-50%)',
        zIndex: 2147483645,
        maxWidth: 'min(94vw, 30rem)',
        width: 'calc(100% - 2rem)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.75rem 0.875rem',
          borderRadius: '0.875rem',
          border: '1px solid rgba(0,0,0,0.08)',
          background: '#ffffff',
          color: '#111827',
          boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          fontSize: '0.875rem',
          lineHeight: 1.35,
        }}
      >
        <span style={{ flex: 1 }}>
          Enable notifications to get timely updates.
        </span>
        <button
          type="button"
          onClick={enable}
          style={{
            flexShrink: 0,
            padding: '0.4rem 0.85rem',
            borderRadius: '0.6rem',
            border: 'none',
            background: 'var(--brand-primary, #111827)',
            color: '#fff',
            fontWeight: 600,
            fontSize: '0.8125rem',
            cursor: 'pointer',
          }}
        >
          Enable
        </button>
        <button
          type="button"
          onClick={dismiss}
          style={{
            flexShrink: 0,
            padding: '0.4rem 0.6rem',
            borderRadius: '0.6rem',
            border: 'none',
            background: 'transparent',
            color: '#6b7280',
            fontWeight: 600,
            fontSize: '0.8125rem',
            cursor: 'pointer',
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
