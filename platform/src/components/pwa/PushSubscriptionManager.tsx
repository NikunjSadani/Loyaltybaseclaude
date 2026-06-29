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
//   • 'default' and not previously dismissed => show a small non-intrusive
//     "Enable notifications" prompt. Enable => requestPermission() (gesture) then
//     subscribe on grant. Not now => persist a dismiss flag.
//
// Self-contained: no toast/context dependency, matching ServiceWorkerRegister /
// InstallPrompt. Uses the global --brand-primary CSS var for the Enable button so
// it picks up the tenant colour.
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { subscribeToPush } from '@/lib/pwa/push';

const SCOPED_PREFIXES = ['/sales', '/partner'];
const DISMISS_KEY = 'pwa-push-dismissed';

function inScope(pathname: string): boolean {
  return SCOPED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  );
}

export default function PushSubscriptionManager() {
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    // Gate 1: flag must be explicitly 'true'. Unset => fully inert. Read here (not
    // at module load) so Next inlines it the same way while staying test-stubbable.
    if (process.env.NEXT_PUBLIC_PWA_PUSH_ENABLED !== 'true') return;
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

    // permission === 'default': offer the opt-in unless already dismissed.
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch {
      /* storage blocked — proceed without persistence */
    }
    setShowPrompt(true);
  }, []);

  const persistDismissal = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
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
    persistDismissal();
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
