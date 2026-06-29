// -----------------------------------------------------------------------------
// install-prompt-store — PWA install-prompt singleton (app-wide).
//
// The browser fires `beforeinstallprompt` ONCE, early on load. A button on a
// Profile page that lets the user install "anytime" therefore needs the deferred
// event to have been captured globally — not inside a single component that may
// not be mounted yet. This module is that single source of truth: it attaches one
// global listener on first client import, stores the deferred event, and exposes
// a tiny subscribe/getState/promptInstall API (+ a React hook).
//
// Client-only and SSR-safe: every window/navigator access is guarded so importing
// this on the server is inert.
// -----------------------------------------------------------------------------

import { useEffect, useState } from 'react';

export interface InstallState {
  canInstall: boolean;
  installed: boolean;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredEvent: BeforeInstallPromptEvent | null = null;
let installed = false;
let listenersAttached = false;
const subscribers = new Set<() => void>();

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mm = window.matchMedia?.('(display-mode: standalone)')?.matches;
  const iosStandalone =
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return Boolean(mm) || iosStandalone;
}

function notify(): void {
  subscribers.forEach((cb) => {
    cb();
  });
}

function ensureListeners(): void {
  if (listenersAttached) return;
  if (typeof window === 'undefined') return;
  listenersAttached = true;

  // Seed `installed` from the current display mode (covers an already-installed
  // app where the event never fires).
  if (detectStandalone()) installed = true;

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    // Stop Chrome's mini-infobar; we drive our own affordance.
    e.preventDefault();
    deferredEvent = e as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    deferredEvent = null;
    installed = true;
    notify();
  });
}

// Attach as a side effect of the first client import.
ensureListeners();

export function getInstallState(): InstallState {
  const isInstalled = installed || detectStandalone();
  return {
    installed: isInstalled,
    canInstall: deferredEvent !== null && !isInstalled,
  };
}

export function subscribe(cb: () => void): () => void {
  // Make sure listeners exist even if getInstallState() was never called first
  // (e.g. on a client that imported only `subscribe`).
  ensureListeners();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const evt = deferredEvent;
  if (!evt) return 'unavailable';
  try {
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    // A deferred prompt is single-use — discard it regardless of outcome.
    deferredEvent = null;
    notify();
    return outcome;
  } catch {
    deferredEvent = null;
    notify();
    return 'unavailable';
  }
}

/**
 * React hook over the singleton: subscribes on mount, returns the live install
 * state plus the `promptInstall` action. Safe to call from any client component.
 */
export function useInstallPrompt(): InstallState & {
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
} {
  const [state, setState] = useState<InstallState>(() => getInstallState());

  useEffect(() => {
    // Re-read once on mount (the event may have fired before this component
    // existed) and on every notify.
    setState(getInstallState());
    const unsubscribe = subscribe(() => {
      setState(getInstallState());
    });
    return unsubscribe;
  }, []);

  return { ...state, promptInstall };
}
