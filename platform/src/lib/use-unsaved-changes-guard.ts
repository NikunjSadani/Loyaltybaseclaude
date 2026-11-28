'use client';

import { useEffect, useRef } from 'react';

/** Marker on the extra history entry pushed while dirty (so Back can be intercepted). */
const GUARD_KEY = '__unsavedGuard';

/**
 * While `dirty`, warn before the user leaves with unsaved edits — on every exit path:
 *   - full unload (reload / close / external URL)  → the browser's own `beforeunload` prompt;
 *   - in-app link clicks (same-origin <a href>, incl. next/link) → a capture-phase click handler
 *     asks `confirm(message)` and, on Cancel, stops the navigation before the Link handler runs;
 *   - browser Back → a guard history entry (same URL) is pushed while dirty; popping it asks
 *     `confirm(message)`: Cancel re-arms the guard, OK goes back for real.
 * Every listener is removed as soon as the form is clean again or the component unmounts; if the
 * guard entry is still on top when the form becomes clean, it is popped so Back needs no extra press.
 *
 * Not intercepted (deliberately): modifier / middle clicks and target="_blank" (they open a new tab,
 * nothing is lost), download links, and same-page #hash links.
 */
export function useUnsavedChangesGuard(dirty: boolean, message: string): void {
  const messageRef = useRef(message);
  useEffect(() => { messageRef.current = message; }, [message]);

  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return;
    const ask = () => window.confirm(messageRef.current);

    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      if ((a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      let url: URL;
      try { url = new URL(a.getAttribute('href') ?? '', window.location.href); } catch { return; }
      if (url.origin !== window.location.origin) return; // full unload → beforeunload covers it
      if (url.pathname === window.location.pathname && url.search === window.location.search) return; // #hash on this page
      if (ask()) {
        leaving = true; // the owner chose to leave — never pop the guard entry under the navigation
      } else {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    let leaving = false;
    // Back: push one guard entry (same URL) so the first Back lands on our popstate.
    window.history.pushState({ ...(window.history.state ?? {}), [GUARD_KEY]: true }, '', window.location.href);
    const guardPath = window.location.pathname + window.location.search;
    const onPopState = () => {
      if (leaving) return;
      if (ask()) {
        leaving = true;
        window.removeEventListener('popstate', onPopState);
        window.history.back();
      } else {
        window.history.pushState({ ...(window.history.state ?? {}), [GUARD_KEY]: true }, '', window.location.href);
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
      // Became clean with our guard entry still on top → drop it (same URL, no visible change) so
      // Back needs no extra press. Deferred a tick and re-checked, so a navigation that is unmounting
      // this page (router has pushed a new URL by then) is never undone.
      if (leaving) return;
      setTimeout(() => {
        const onGuard = (window.history.state as Record<string, unknown> | null)?.[GUARD_KEY];
        if (onGuard && window.location.pathname + window.location.search === guardPath) window.history.back();
      }, 0);
    };
  }, [dirty]);
}
