'use client';

import { useEffect } from 'react';
import { isStaleDeploymentError, recoverFromStaleDeployment } from '@/lib/stale-deploy';

/**
 * StaleDeploymentGuard — app-wide self-healing for the Next "Failed to find Server Action"
 * error (a tab left open across a deploy firing a server action with a now-stale action id).
 *
 * Catches the UNCAUGHT path: any server-action rejection that isn't handled by its caller
 * surfaces as an `unhandledrejection` (or a global `error`); on a deploy-skew match we do a
 * guarded one-shot reload so the tab silently pulls the new bundle instead of showing the
 * raw red banner. Callers that CATCH the rejection themselves (e.g. the brand switcher) wire
 * the same recovery in their own catch. Mounted once, app-wide, in the root layout.
 */
let installed = false;

export default function StaleDeploymentGuard() {
  useEffect(() => {
    if (installed || typeof window === 'undefined') return;
    installed = true;

    const onRejection = (e: PromiseRejectionEvent) => {
      if (isStaleDeploymentError(e.reason)) recoverFromStaleDeployment();
    };
    const onError = (e: ErrorEvent) => {
      if (isStaleDeploymentError(e.error ?? e.message)) recoverFromStaleDeployment();
    };

    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    // Not removed on unmount: the guard must persist for the whole app session (mirrors
    // SessionExpiryGuard); `installed` keeps it a single registration across remounts.
  }, []);

  return null;
}
