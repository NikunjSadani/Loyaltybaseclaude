'use client';

// -----------------------------------------------------------------------------
// ServiceWorkerRegister — PWA phase F3 (SHIPPED DISABLED).
//
// Drop-in client component the root layout mounts. It is INERT unless ALL of:
//   1. NEXT_PUBLIC_PWA_SW_ENABLED === 'true'  (default/unset = OFF)
//   2. the current path starts with /sales or /partner (SW scope)
//   3. the browser supports service workers
//
// When active it registers /sw.js, watches for a newer waiting SW, and surfaces a
// non-intrusive "New version available — Refresh" banner. Accepting it tells the
// waiting SW to skipWaiting, then reloads — so the user is at most one load behind.
//
// Self-contained: no toast/context dependency, so it is safe wherever it is
// mounted. Kept dependency-light on purpose.
// -----------------------------------------------------------------------------
import { useEffect, useState } from 'react';

const SW_ENABLED = process.env.NEXT_PUBLIC_PWA_SW_ENABLED === 'true';
const SCOPED_PREFIXES = ['/sales', '/partner'];

function inScope(pathname: string): boolean {
  return SCOPED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export default function ServiceWorkerRegister() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    // Gate 1: flag must be explicitly 'true'. Unset => fully inert.
    if (!SW_ENABLED) return;
    // Gate 2: only inside the /sales + /partner shells.
    if (typeof window === 'undefined' || !inScope(window.location.pathname)) return;
    // Gate 3: unsupported browser => no-op silently.
    if (!('serviceWorker' in navigator)) return;

    let cancelled = false;

    // Promote a worker to "waiting" => offer the refresh prompt.
    const trackInstalling = (worker: ServiceWorker | null) => {
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        // Only show the prompt for an UPDATE (controller already exists), not the
        // very first install, where there is nothing stale to replace.
        if (
          worker.state === 'installed' &&
          navigator.serviceWorker.controller &&
          !cancelled
        ) {
          setWaitingWorker(worker);
        }
      });
    };

    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => {
        if (cancelled) return;
        // A new SW may already be waiting (installed between visits).
        if (registration.waiting && navigator.serviceWorker.controller) {
          setWaitingWorker(registration.waiting);
        }
        trackInstalling(registration.installing);
        registration.addEventListener('updatefound', () => {
          trackInstalling(registration.installing);
        });
      })
      .catch(() => {
        // Registration failures must never break the app — swallow silently.
      });

    // When the activated SW takes control, reload once so the new shell is live.
    let reloaded = false;
    const onControllerChange = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        onControllerChange,
      );
    };
  }, []);

  const applyUpdate = () => {
    // Tell the waiting SW to activate; controllerchange (above) then reloads.
    waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
    setWaitingWorker(null);
  };

  if (!waitingWorker) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '1rem',
        transform: 'translateX(-50%)',
        zIndex: 2147483647,
        maxWidth: 'min(92vw, 28rem)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.625rem 0.875rem',
          borderRadius: '0.75rem',
          border: '1px solid rgba(0,0,0,0.08)',
          background: '#111827',
          color: '#fff',
          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
          fontSize: '0.875rem',
          lineHeight: 1.3,
        }}
      >
        <span style={{ flex: 1 }}>A new version is available.</span>
        <button
          type="button"
          onClick={applyUpdate}
          style={{
            flexShrink: 0,
            padding: '0.375rem 0.75rem',
            borderRadius: '0.5rem',
            border: 'none',
            background: '#fff',
            color: '#111827',
            fontWeight: 600,
            fontSize: '0.8125rem',
            cursor: 'pointer',
          }}
        >
          Refresh
        </button>
      </div>
    </div>
  );
}
