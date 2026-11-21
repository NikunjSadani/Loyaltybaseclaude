'use client';

import { useSyncExternalStore } from 'react';

/**
 * Today's date as a display label (IST), rendered HYDRATION-SAFELY.
 *
 * A `new Date()` read during render is baked into the server/prerendered HTML (a statically
 * prerendered page keeps its BUILD date) and the server's ICU data can format differently from the
 * browser's — either one makes the first client render differ from the SSR HTML (React error #418).
 * Here the server / hydration snapshot is `null` (callers render a same-height placeholder) and the
 * client snapshot is the formatted date, so the label fills in right after hydration.
 */
export const TODAY_LABEL_FORMAT: Intl.DateTimeFormatOptions = {
  timeZone: 'Asia/Kolkata',
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
};

const noopSubscribe = (): (() => void) => () => {};

/** Client snapshot — a primitive string, so React's Object.is check is stable within a day. */
export function getTodayLabelSnapshot(): string {
  return new Date().toLocaleDateString('en-IN', TODAY_LABEL_FORMAT);
}

/** Server / hydration snapshot — no date on the server (it could not match the browser's). */
export function getTodayLabelServerSnapshot(): null {
  return null;
}

export function useTodayLabel(): string | null {
  return useSyncExternalStore(noopSubscribe, getTodayLabelSnapshot, getTodayLabelServerSnapshot);
}
