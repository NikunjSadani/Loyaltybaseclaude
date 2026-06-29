'use client';

// -----------------------------------------------------------------------------
// InstallBeacon — PWA install telemetry. SHIPPED DISABLED.
//
// Side-effect-only client component the root layout mounts (alongside
// PushSubscriptionManager). INERT (renders null, no fetch) unless
// NEXT_PUBLIC_PWA_INSTALL_ENABLED === 'true' (default/unset = OFF).
//
// When enabled, it reports — at most once per browser session — that the app is
// running as an INSTALLED PWA, so the admin "App Adoption" page can count home-
// screen installs. It fires when EITHER:
//   • on mount the app is already in standalone display mode (re-launched from the
//     home screen), OR
//   • the browser fires `appinstalled` (just installed this session).
//
// Standalone detection covers both the standard display-mode media query and the
// legacy iOS Safari `navigator.standalone` flag. Platform is derived from the UA.
//
// Best-effort throughout: the POST is wrapped in try/catch, never throws, never
// blocks render. Mirrors PushSubscriptionManager's gating (flag read INSIDE the
// effect so Next still inlines it while staying test-stubbable) and SSR-safety.
// -----------------------------------------------------------------------------
import { useEffect } from 'react';
import { authHeader } from '@/lib/api-client';

const BEACON_SENT_KEY = 'pwa-install-beacon-sent';

type InstallPlatform = 'ANDROID' | 'IOS' | 'DESKTOP' | 'OTHER';

function detectPlatform(ua: string): InstallPlatform {
  if (/Android/i.test(ua)) return 'ANDROID';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'IOS';
  if (/Windows|Macintosh|Linux|CrOS/i.test(ua)) return 'DESKTOP';
  return 'OTHER';
}

// True when the app is running as an installed PWA: standard display-mode match
// OR the legacy iOS Safari standalone flag.
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(display-mode: standalone)')?.matches) return true;
  } catch {
    /* matchMedia unavailable — fall through to the iOS flag */
  }
  return (navigator as unknown as { standalone?: boolean }).standalone === true;
}

export default function InstallBeacon() {
  useEffect(() => {
    // Gate: flag must be explicitly 'true'. Unset => fully inert. Read here (not at
    // module load) so Next inlines it the same way while staying test-stubbable.
    if (process.env.NEXT_PUBLIC_PWA_INSTALL_ENABLED !== 'true') return;
    if (typeof window === 'undefined') return;

    // Fire the beacon at most once per browser session.
    const send = () => {
      try {
        if (sessionStorage.getItem(BEACON_SENT_KEY) === '1') return;
        sessionStorage.setItem(BEACON_SENT_KEY, '1');
      } catch {
        /* storage blocked — proceed without the once-guard rather than spamming;
           a missing sessionStorage means a fresh/incognito context anyway */
      }
      try {
        const ua = navigator.userAgent ?? '';
        void fetch('/api/push/installed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          body: JSON.stringify({
            platform: detectPlatform(ua),
            userAgent: ua.slice(0, 512),
          }),
        }).catch(() => {
          /* best-effort telemetry — swallow network/backend errors */
        });
      } catch {
        /* never throw from a side-effect-only telemetry component */
      }
    };

    // Already running standalone (re-launched from the home screen) => report now.
    if (isStandalone()) send();

    // Just installed this session => report immediately.
    const onInstalled = () => send();
    window.addEventListener('appinstalled', onInstalled);
    return () => window.removeEventListener('appinstalled', onInstalled);
  }, []);

  // Side-effect only.
  return null;
}
