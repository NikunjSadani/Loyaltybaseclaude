'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { getAssumedBrand, clearAssumedContext } from './auth-client'
import { getAssumedContext } from './auth-actions'
import { useHydrated } from './use-hydrated'

/**
 * Shared assumed-tenant signal (mirrors the OperatorBanner AF-6 self-heal).
 *
 * A GIFSY operator can "assume" a tenant to view its data. Surfaces that render
 * PLATFORM-GLOBAL affordances (e.g. the Settings page's Report Recipients + Security
 * & Platform Config cards) must react to that context so they never let the operator
 * edit platform state while it reads as a single brand's.
 *
 * Behaviour, encapsulated once so consumers can never drift:
 *  1. OPTIMISTIC seed — the initial state reads the synchronous localStorage hint
 *     (getAssumedBrand) so an assumed operator never sees a flash of the platform
 *     cards on first paint.
 *  2. RECONCILE against SERVER TRUTH — getAssumedContext() reads the httpOnly cookie
 *     token; a stale hint can never keep the assumed state alive. An `alive` guard
 *     drops a late resolve after unmount.
 *  3. SELF-HEAL across tabs — window 'storage' (cross-tab assume/exit) re-reads the
 *     hint synchronously, and window 'focus' re-runs the full server reconcile. So if
 *     the operator Exits to platform in another tab, THIS surface un-hides the
 *     platform cards on the next focus/storage tick WITHOUT a manual reload.
 *
 * @returns `brand` (the assumed brand name, or null at platform level) and the derived
 * `assumed` boolean.
 */
export function useAssumedContext(): { brand: string | null; assumed: boolean; ready: boolean } {
  // `ready` = false only during the server / hydration render, where `brand` is the server
  // default (null) rather than the stored hint. Any decision on `assumed` (redirect, access gate,
  // request) MUST wait for it — otherwise an assumed operator reads as un-assumed on a hard load.
  const ready = useHydrated()
  // Optimistic synchronous seed from the localStorage hint — avoids a first-paint flash of the
  // platform-global cards. Read through useSyncExternalStore so it is HYDRATION-SAFE: the server
  // and the hydration render both see `null` (no localStorage on the server → no React #418), and
  // a component mounted after hydration reads the hint synchronously on its first render.
  const hint = useSyncExternalStore(subscribeAssumedHint, getAssumedBrand, getNullServerSnapshot)
  // Server truth (or a newer hint after a cross-tab change) overrides the optimistic hint.
  // `undefined` = not reconciled yet → fall back to the hint.
  const [reconciled, setReconciled] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const reconcile = () => {
      getAssumedContext()
        .then((ctx) => {
          if (!alive) return
          const b = ctx?.brandName ?? null
          setReconciled(b)
          // Server truth says un-assumed → scrub the stale localStorage hint too, so a
          // later cross-tab 'storage' event can't re-read a stale hint and transiently flip
          // an editable card back to the placeholder. Makes the hook self-consistent instead
          // of depending on the co-mounted OperatorBanner to scrub it (mirrors AF-6).
          if (!b) clearAssumedContext()
        })
        .catch(() => { /* non-fatal — keep the optimistic value */ })
    }
    reconcile()
    // Cross-tab assume/exit → the hint (re-read by useSyncExternalStore) wins again until the
    // next reconcile; tab focus → full server reconcile.
    const onStorage = () => setReconciled(undefined)
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', reconcile)
    return () => {
      alive = false
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', reconcile)
    }
  }, [])

  const brand = reconciled !== undefined ? reconciled : hint
  return { brand, assumed: !!brand, ready }
}

function subscribeAssumedHint(onChange: () => void): () => void {
  window.addEventListener('storage', onChange)
  return () => window.removeEventListener('storage', onChange)
}

function getNullServerSnapshot(): null {
  return null
}
