import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isIosSafari } from '../platform-detect';

/**
 * isIosSafari() must be TRUE only for a REAL iOS Safari (iPhone/iPod Safari, or an
 * iPadOS "Macintosh" UA that also exposes touch) — the only place the "Share → Add to
 * Home Screen" instructions apply. Every Chromium/Gecko browser (incl. DESKTOP CHROME,
 * whose UA also carries the "Safari" token, and on a Mac exposes `ontouchend`) must be
 * FALSE, or it is wrongly shown the impossible iOS install hint.
 */

// Real-world user-agent strings.
const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipadSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  firefoxWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
} as const;

function setUserAgent(ua: string) {
  vi.stubGlobal('navigator', { userAgent: ua });
}

/** Control `'ontouchend' in document` (the iPadOS "Macintosh" touch heuristic). */
function setTouch(on: boolean) {
  if (on) {
    Object.defineProperty(document, 'ontouchend', { value: null, configurable: true });
  } else {
    // delete is a no-op (returns true) when the prop is absent.
    delete (document as unknown as { ontouchend?: unknown }).ontouchend;
  }
}

describe('isIosSafari', () => {
  beforeEach(() => {
    setTouch(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setTouch(false);
  });

  it('desktop Chrome on macOS → false (UA carries "Safari"; ontouchend present)', () => {
    setUserAgent(UA.chromeMac);
    setTouch(true); // Chrome-on-Mac exposes ontouchend — must NOT trip the iPad heuristic.
    expect(isIosSafari()).toBe(false);
  });

  it('desktop Chrome on Windows → false', () => {
    setUserAgent(UA.chromeWin);
    expect(isIosSafari()).toBe(false);
  });

  it('real iPhone Safari → true', () => {
    setUserAgent(UA.iphoneSafari);
    expect(isIosSafari()).toBe(true);
  });

  it('iPad Safari (Macintosh UA + ontouchend) → true', () => {
    setUserAgent(UA.ipadSafari);
    setTouch(true);
    expect(isIosSafari()).toBe(true);
  });

  it('iOS Chrome (CriOS) → false', () => {
    setUserAgent(UA.iosChrome);
    expect(isIosSafari()).toBe(false);
  });

  it('desktop Edge → false', () => {
    setUserAgent(UA.edgeWin);
    expect(isIosSafari()).toBe(false);
  });

  it('desktop Firefox → false', () => {
    setUserAgent(UA.firefoxWin);
    expect(isIosSafari()).toBe(false);
  });
});
