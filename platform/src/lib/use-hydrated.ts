'use client';

import { useSyncExternalStore } from 'react';

const noopSubscribe = (): (() => void) => () => {};
const clientTrue = (): boolean => true;
const serverFalse = (): boolean => false;

/**
 * `false` on the server and during the HYDRATION render; `true` from the re-render right after
 * hydration — the same render in which every useSyncExternalStore-backed client store (gifsy
 * settings, assumed-brand hint, install state) switches from its server snapshot to the client
 * value. A component that mounts after hydration (client navigation, or under RequireAuth) gets
 * `true` on its very first render.
 *
 * Use it to hold back any DECISION (redirect, access gate, request, "feature is OFF" panel) that
 * depends on client-only state, so it is never taken on the server-default value.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, clientTrue, serverFalse);
}
