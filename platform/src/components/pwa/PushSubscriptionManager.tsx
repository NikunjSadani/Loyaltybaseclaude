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
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { subscribeToPush } from '@/lib/pwa/push';

const SCOPED_PREFIXES = ['/sales', '/partner'];
const SNOOZE_KEY = 'pwa-push-snooze';
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

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

export default function PushSubscriptionManager({ tenantSlug }: { tenantSlug?: string }) {
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    // Gate 1: the global flag OR the tenant being Bajaj. Flag read here (not at module
    // load) so Next inlines it the same way while staying test-stubbable. Other tenants
    // stay flag-only (default OFF) → byte-identical.
    const bajaj = (tenantSlug ?? '').trim().toLowerCase() === 'bajaj';
    if (!(process.env.NEXT_PUBLIC_PWA_PUSH_ENABLED === 'true' || bajaj)) return;
    if (typeof window === 'undefined') return;
    // Gate 2: only inside the /sales + /partner shells.
    if (!inScope(window.location.pathname)) return;
    // Gate 3: unsupported browser => no-op silently.
    if (!pushSupported() || typeof Notification === 'undefined') return;

    const permission = Notification.permission;

    if (permission === 'granted') {
      // Already granted: re-sync the subscription (idempotent). No UI.
      void subscribeToPush();
      return;
    }

    if (permission === 'denied') {
      // Hard denial: never prompt.
      return;
    }

    // permission === 'default':
    if (isSnoozed()) return;

    if (bajaj) {
      // Bajaj: ask AUTOMATICALLY at login (no in-app banner first). Chromium/Android
      // shows the browser prompt without a gesture; browsers that REQUIRE a user gesture
      // (Safari/Firefox) resolve 'default' or throw → fall back to the in-app "Enable"
      // banner so the user can still trigger it with a tap.
      let cancelled = false;
      void (async () => {
        let result: NotificationPermission | undefined;
        try {
          result = await Notification.requestPermission();
        } catch {
          result = 'default'; // gesture-required browser → treat as unanswered
        }
        if (cancelled) return;
        if (result === 'granted') {
          // subscribe failure must NOT surface the "Enable" banner (permission is already
          // granted) — PwaAppSettings offers a manual retry if the sync didn't land.
          try { await subscribeToPush(); } catch { /* idempotent; retried elsewhere */ }
          return;
        }
        if (result === 'denied') return;
        // 'default'/undefined: dismissed or gesture-required. Snooze so we don't re-prompt
        // on every reload (Chromium auto-blocks repeated dismissals), and offer the
        // tap-to-enable banner for this session.
        persistSnooze();
        setShowPrompt(true);
      })();
      return () => { cancelled = true; };
    }

    // Non-Bajaj (flag on): offer the in-app opt-in banner (unchanged behaviour).
    setShowPrompt(true);
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
