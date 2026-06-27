'use client';

// -----------------------------------------------------------------------------
// InstallPrompt — PWA phase F4 (install UX). SHIPPED DISABLED.
//
// Drop-in client component the root layout mounts. INERT unless ALL of:
//   1. NEXT_PUBLIC_PWA_INSTALL_ENABLED === 'true'  (default/unset = OFF, so it
//      can't surprise UAT testers; flip ON once mobile flows are stable)
//   2. the current path starts with /sales or /partner (install scope)
//   3. the app is NOT already installed (display-mode: standalone / iOS standalone)
//   4. the user hasn't dismissed/installed before (persisted in localStorage)
//
//   • Android / Chromium: captures `beforeinstallprompt`, defers it, and offers a
//     custom "Install" affordance that calls prompt() on tap.
//   • iOS Safari: no install API exists — shows an instructional "Share → Add to
//     Home Screen" banner (only on iOS Safari, where A2HS is actually possible).
//
// Self-contained: no toast/context dependency. Uses the global --brand-primary CSS
// var (set by the root layout) so the Install button picks up the tenant colour.
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';

const SCOPED_PREFIXES = ['/sales', '/partner'];
const DISMISS_KEY = 'pwa-install-dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function inScope(pathname: string): boolean {
  return SCOPED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mm = window.matchMedia?.('(display-mode: standalone)')?.matches;
  const iosStandalone =
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(mm) || iosStandalone;
}

// iOS "Add to Home Screen" only works in Safari (Chrome/Firefox/Edge on iOS can't
// install). Detect an iOS device AND Safari (exclude the in-app browsers via their
// UA tokens). iPadOS 13+ reports as "Macintosh", so also treat a touch-capable Mac
// as iOS.
function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS =
    /iphone|ipad|ipod/i.test(ua) ||
    (/macintosh/i.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  const safari = /safari/i.test(ua) && !/crios|fxios|edgios|opios/i.test(ua);
  return iOS && safari;
}

export default function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [mode, setMode] = useState<'android' | 'ios' | null>(null);

  useEffect(() => {
    // Gate 1: flag must be explicitly 'true'. Unset => fully inert.
    if (process.env.NEXT_PUBLIC_PWA_INSTALL_ENABLED !== 'true') return;
    if (typeof window === 'undefined') return;
    // Gate 2: only inside the /sales + /partner shells.
    if (!inScope(window.location.pathname)) return;
    // Gate 3: already installed => nothing to prompt.
    if (isStandalone()) return;
    // Gate 4: respect a prior dismissal/install.
    try {
      if (localStorage.getItem(DISMISS_KEY) === '1') return;
    } catch {
      /* storage blocked — proceed without persistence */
    }

    const onBeforeInstallPrompt = (e: Event) => {
      // Stop Chrome's mini-infobar; we present our own affordance instead.
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setMode('android');
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);

    // iOS Safari never fires beforeinstallprompt — offer the manual instruction.
    if (isIosSafari()) setMode('ios');

    const onInstalled = () => {
      setMode(null);
      try {
        localStorage.setItem(DISMISS_KEY, '1');
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const persistDismissal = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
  };

  const dismiss = () => {
    setMode(null);
    persistDismissal();
  };

  const install = async () => {
    if (!deferred) return;
    try {
      await deferred.prompt();
      await deferred.userChoice;
    } catch {
      /* not a user gesture / unsupported — fail silently */
    }
    setDeferred(null);
    setMode(null);
    persistDismissal();
  };

  if (!mode) return null;

  return (
    <div
      role="dialog"
      aria-label="Install app"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '1rem',
        transform: 'translateX(-50%)',
        zIndex: 2147483646,
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
          {mode === 'android'
            ? 'Install this app for a faster, full-screen experience.'
            : 'Install this app: tap the Share button, then “Add to Home Screen”.'}
        </span>
        {mode === 'android' && (
          <button
            type="button"
            onClick={install}
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
            Install
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          style={{
            flexShrink: 0,
            padding: '0.25rem 0.5rem',
            borderRadius: '0.5rem',
            border: 'none',
            background: 'transparent',
            color: '#6b7280',
            fontSize: '1.1rem',
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
