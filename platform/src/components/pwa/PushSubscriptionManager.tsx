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
//   • shown once per session (sessionStorage, keyed to the signed-in user) whenever
//     notifications are NOT granted — default, denied, install-first (iPhone tab),
//     too-old iOS or unsupported — with device-specific steps;
//   • "Remind me later" / × / Escape hide it for the rest of the session; it comes
//     back on the next app open until notifications are allowed;
//   • the 3-day `pwa-push-snooze` is neither read nor written for Bajaj (it would
//     hide the reminder for 3 days, which conflicts with "every app open");
//   • the auto-request at load is kept (Android shows the native prompt directly);
//     the reminder appears only if that didn't end in 'granted'.
// Every other tenant keeps the original bar + snooze below, byte-identical.
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { subscribeToPush } from '@/lib/pwa/push';
import { currentLocationPlatform } from '@/lib/location-gate';
import { isIosSafari } from '@/lib/pwa/platform-detect';
import { parseIosVersion, type NotificationState } from '@/lib/pwa/notification-guide';
import NotificationReminder from './NotificationReminder';

const SCOPED_PREFIXES = ['/sales', '/partner'];
const SNOOZE_KEY = 'pwa-push-snooze';
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
/** Bajaj reminder: set (to the signed-in user's id) once the reminder has been shown this session. */
export const REMINDER_SESSION_KEY = 'pwa-notif-reminder';

/** The signed-in user's id from the non-sensitive stored user (login writes it), or '' if unknown. */
function storedUserId(): string {
  try {
    const raw = localStorage.getItem('user');
    if (!raw) return '';
    const id = (JSON.parse(raw) as { id?: unknown })?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
  } catch {
    return '';
  }
}

/** True when this user already saw the reminder in this session (a different user signing in sees it again). */
function reminderSeenThisSession(): boolean {
  try {
    const v = sessionStorage.getItem(REMINDER_SESSION_KEY);
    return v !== null && v === storedUserId();
  } catch {
    return false;
  }
}

function markReminderSeen() {
  try {
    sessionStorage.setItem(REMINDER_SESSION_KEY, storedUserId());
  } catch {
    /* storage blocked — the reminder may show again on a full reload, never worse than that */
  }
}

interface ReminderSetup {
  platform: ReturnType<typeof currentLocationPlatform>;
  state: NotificationState;
  iosVersion: ReturnType<typeof parseIosVersion>;
  inSafari: boolean;
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
  /** Tenant display name, used only in the Bajaj reminder's Settings steps. */
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
    function runBajaj(): (() => void) | undefined {
      const supported = pushSupported() && typeof Notification !== 'undefined';
      const permission: NotificationState = supported ? Notification.permission : 'unsupported';

      if (permission === 'granted') {
        // Already granted: re-sync the subscription (idempotent). No UI.
        void subscribeToPush({ background: true });
        return;
      }
      // Already reminded this session ("Remind me later" = rest of the session) → no auto-ask, no reminder.
      if (reminderSeenThisSession()) return;

      const platform = currentLocationPlatform();
      const base = {
        platform,
        iosVersion: parseIosVersion(navigator.userAgent),
        inSafari: isIosSafari(),
        host: window.location.host,
      };
      const show = (state: NotificationState) => {
        markReminderSeen();
        setReminder({ ...base, state });
      };

      // Can still ask, and not an iPhone browser tab (push can't work there) → ask AUTOMATICALLY first.
      // Chromium/Android shows the native prompt without a gesture; gesture-required browsers (Safari/
      // Firefox, iOS Home Screen app) resolve 'default' or throw → the reminder's Enable button (a tap).
      if (permission === 'default' && platform !== 'ios-safari') {
        let cancelled = false;
        void (async () => {
          let result: NotificationPermission | undefined;
          try {
            result = await Notification.requestPermission();
          } catch {
            result = 'default';
          }
          if (cancelled) return;
          if (result === 'granted') {
            // subscribe failure must NOT surface the reminder (permission is granted) — the next load
            // re-syncs, and PwaAppSettings offers a manual retry.
            try { await subscribeToPush({ background: true }); } catch { /* idempotent; retried elsewhere */ }
            return;
          }
          // Re-read the REAL state: some browsers resolve 'denied' for an un-shown, gesture-less request.
          const real = Notification.permission;
          if (real === 'granted') {
            try { await subscribeToPush({ background: true }); } catch { /* idempotent */ }
            return;
          }
          show(real);
        })();
        return () => { cancelled = true; };
      }

      show(permission);
      return;
    }
  }, [tenantSlug]);

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
    return (
      <NotificationReminder
        platform={reminder.platform}
        initialState={reminder.state}
        iosVersion={reminder.iosVersion}
        inSafari={reminder.inSafari}
        host={reminder.host}
        appName={appName}
        onClose={() => setReminder(null)}
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
