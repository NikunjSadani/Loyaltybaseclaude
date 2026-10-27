'use client';

// -----------------------------------------------------------------------------
// InstallPrompt — PWA phase F4 (install UX). SHIPPED DISABLED.
//
// Drop-in client component the root layout mounts. INERT unless ALL of:
//   1. NEXT_PUBLIC_PWA_INSTALL_ENABLED === 'true'  (default/unset = OFF, so it
//      can't surprise UAT testers; flip ON once mobile flows are stable)
//   2. the current path starts with /sales or /partner (install scope)
//   3. the app is NOT already installed (display-mode: standalone / iOS standalone)
//   4. the user hasn't SNOOZED the banner within the last 3 days
//
//   • Android / Chromium: consumes the app-wide install-prompt store (single
//     source of truth) and offers a custom "Install" affordance.
//   • iOS Safari: no install API exists — shows an instructional "Share → Add to
//     Home Screen" banner (only on iOS Safari, where A2HS is actually possible).
//
// Declining is a SNOOZE, not a permanent dismissal: the banner re-appears after
// 3 days, and the Profile page (PwaAppSettings) offers a persistent entry point
// so users can always install.
//
// Self-contained: no toast/context dependency. Uses the global --brand-primary CSS
// var (set by the root layout) so the Install button picks up the tenant colour.
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';
import { isIosSafari } from '@/lib/pwa/platform-detect';
import { useInstallPrompt } from '@/lib/pwa/install-prompt-store';

const SCOPED_PREFIXES = ['/sales', '/partner'];
const SNOOZE_KEY = 'pwa-install-snooze';
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

export default function InstallPrompt({ tenantSlug }: { tenantSlug?: string }) {
  const { canInstall, installed, promptInstall } = useInstallPrompt();
  // 'mode' is set once the mount-time gates pass; it also picks the banner copy
  // (android = custom install button, ios = manual Share instructions).
  const [mode, setMode] = useState<'android' | 'ios' | null>(null);

  useEffect(() => {
    // Gate 1: the global flag OR the tenant being Bajaj. Other tenants stay flag-only
    // (default OFF) → byte-identical.
    const bajaj = (tenantSlug ?? '').trim().toLowerCase() === 'bajaj';
    if (!(process.env.NEXT_PUBLIC_PWA_INSTALL_ENABLED === 'true' || bajaj)) return;
    if (typeof window === 'undefined') return;
    // Gate 2: only inside the /sales + /partner shells.
    if (!inScope(window.location.pathname)) return;
    // Gate 3: already installed => the store's `installed` already suppresses.
    if (installed) return;
    // Gate 4: respect an active snooze.
    if (isSnoozed()) return;

    // iOS Safari never fires beforeinstallprompt — offer the manual instruction.
    setMode(isIosSafari() ? 'ios' : 'android');
  }, [installed, tenantSlug]);

  const snooze = () => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now()));
    } catch {
      /* storage blocked — proceed without persistence */
    }
  };

  const dismiss = () => {
    setMode(null);
    snooze();
  };

  const install = async () => {
    await promptInstall();
    setMode(null);
  };

  if (!mode) return null;
  // Android banner only makes sense when the store actually has a deferred prompt.
  if (mode === 'android' && !canInstall) return null;

  return (
    // Full-screen dimmed backdrop; tapping it = dismiss (snooze). The card is centered.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Install app"
      onClick={dismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483646,
        background: 'rgba(17,24,39,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: 'min(92vw, 22rem)',
          background: '#ffffff',
          color: '#111827',
          borderRadius: '1rem',
          boxShadow: '0 20px 50px rgba(0,0,0,0.30)',
          padding: '1.5rem 1.25rem 1.25rem',
          textAlign: 'center',
        }}
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          style={{
            position: 'absolute',
            top: '0.5rem',
            right: '0.5rem',
            padding: '0.25rem 0.5rem',
            borderRadius: '0.5rem',
            border: 'none',
            background: 'transparent',
            color: '#6b7280',
            fontSize: '1.25rem',
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          ×
        </button>
        <p style={{ fontSize: '1rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
          Install the app
        </p>
        <p style={{ fontSize: '0.875rem', lineHeight: 1.45, color: '#374151', margin: '0 0 1.25rem' }}>
          {mode === 'android'
            ? 'Add it to your home screen for a faster, full-screen experience.'
            : 'To install: tap the Share button, then “Add to Home Screen”.'}
        </p>
        {mode === 'android' && (
          <button
            type="button"
            onClick={install}
            style={{
              width: '100%',
              padding: '0.6rem 1rem',
              borderRadius: '0.6rem',
              border: 'none',
              background: 'var(--brand-primary, #111827)',
              color: '#fff',
              fontWeight: 600,
              fontSize: '0.9rem',
              cursor: 'pointer',
            }}
          >
            Install
          </button>
        )}
      </div>
    </div>
  );
}
