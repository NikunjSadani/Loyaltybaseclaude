/// <reference types="vitest/globals" />
import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';
import { __resetSessionCacheForTests } from '@/lib/session-cache';

// Flaky-test sweep 2026-11-15 — suite-wide defaults so a test's correctness never depends on runner speed:
//  * findBy* / waitFor default timeout 1 s -> 15 s. A passing test resolves as soon as the element
//    appears (no slowdown); only a genuinely-failing one waits longer. Must stay < testTimeout (30 s,
//    vitest.config.ts) so a real failure reports the RTL "Unable to find…" message, not a bare timeout.
configure({ asyncUtilTimeout: 15_000 });

//  * Never leak fake timers into the next test: several tests call vi.useRealTimers() at the END of
//    the body, which is skipped when an assertion throws first — the next test would then run on
//    frozen timers and fail for an unrelated reason. Restoring after EVERY test makes that impossible.
afterEach(() => {
  vi.useRealTimers();
});

//  * The client read cache (lib/session-cache.ts) is module state — start every test empty so one test's mocked
//    /api/sales/me (etc.) can never be served to the next test.
beforeEach(() => {
  __resetSessionCacheForTests();
});

// Stub browser APIs not available in jsdom
//
// IMPORTANT: patch jsdom's *actual* HTMLCanvasElement prototype FIRST (before
// any globalThis replacement) so that canvas elements created via JSX / DOM
// parsing (which use jsdom's internal prototype, not globalThis.HTMLCanvasElement)
// also get a working getContext.  Without this the QR-scan interval bails
// immediately on `if (!ctx) return` and jsqr is never called in tests.
const _fakeCtx = {
  beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  clearRect: vi.fn(), fillText: vi.fn(), fillRect: vi.fn(),
  drawImage: vi.fn(),
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
  strokeStyle: '', lineWidth: 0, lineCap: '',
};
Object.defineProperty(globalThis.HTMLCanvasElement.prototype, 'getContext', {
  value: () => _fakeCtx,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis.HTMLCanvasElement.prototype, 'toDataURL', {
  value: () => 'data:image/png;base64,stub',
  configurable: true,
  writable: true,
});

// Stub HTMLVideoElement.play / pause (not implemented in jsdom)
Object.defineProperty(globalThis.HTMLVideoElement.prototype, 'play', {
  value: vi.fn().mockResolvedValue(undefined),
  configurable: true,
});
Object.defineProperty(globalThis.HTMLVideoElement.prototype, 'pause', {
  value: vi.fn(),
  configurable: true,
});

// jsdom does not implement scrollIntoView — stub it
Element.prototype.scrollIntoView = vi.fn();

// jsdom does not implement URL.createObjectURL / revokeObjectURL. Tests stub them per file
// (vi.stubGlobal('URL', …)) and unstub in afterEach, but src/lib/download.ts revokes the blob URL
// in a 1 s setTimeout — under full-suite load that timer fires AFTER the unstub and threw an
// uncaught "URL.revokeObjectURL is not a function" (failed the 2026-11-19 pre-push gate with all
// tests green). Real no-op fallbacks on jsdom's own URL make that late call harmless; per-file stubs
// still override them while a test runs.
if (typeof URL.createObjectURL !== 'function') {
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:jsdom-fallback', configurable: true, writable: true });
}
if (typeof URL.revokeObjectURL !== 'function') {
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true, writable: true });
}

Object.defineProperty(globalThis.navigator, 'geolocation', {
  value: { getCurrentPosition: vi.fn(), watchPosition: vi.fn(), clearWatch: vi.fn() },
  configurable: true,
});

Object.defineProperty(globalThis.navigator, 'mediaDevices', {
  value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
  configurable: true,
});
