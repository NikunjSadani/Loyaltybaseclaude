// -----------------------------------------------------------------------------
// platform-detect — tiny shared PWA platform helpers (client-only, SSR-safe).
//
// Extracted from InstallPrompt so the Profile-page entry point (PwaAppSettings)
// can reuse the exact same iOS-Safari / standalone detection.
// -----------------------------------------------------------------------------

/** True when the app is already running installed (standalone display mode). */
export function isStandalone(): boolean {
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
export function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // Exclude every Chromium/Gecko browser. Critical: DESKTOP CHROME's UA also contains the
  // "Safari" token (and on a Mac, Chrome exposes `ontouchend`, which would otherwise trip the
  // iPadOS heuristic below) — so without excluding `chrome`/`android`/`edg`/`opr` here, desktop
  // Chrome is misdetected as iOS Safari and shown the (impossible) "Share → Add to Home Screen".
  const nonSafari = /crios|fxios|edgios|opios|edg\/|opr\/|chrome|chromium|android|firefox/i.test(ua);
  const iOS =
    /iphone|ipad|ipod/i.test(ua) ||
    (/macintosh/i.test(ua) && typeof document !== 'undefined' && 'ontouchend' in document);
  const safari = /safari/i.test(ua) && !nonSafari;
  return iOS && safari;
}
