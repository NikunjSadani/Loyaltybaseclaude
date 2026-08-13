'use client'

import { useEffect, useState } from 'react'
import { getAssumedBrand, clearAssumedContext } from './auth-client'
import { getAssumedContext } from './auth-actions'

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
export function useAssumedContext(): { brand: string | null; assumed: boolean } {
  // Optimistic synchronous seed from the localStorage hint (null on the server / at
  // platform level) — avoids a first-paint flash of the platform-global cards.
  const [brand, setBrand] = useState<string | null>(() => getAssumedBrand())

  useEffect(() => {
    let alive = true
    const reconcile = () => {
      getAssumedContext()
        .then((ctx) => {
          if (!alive) return
          const b = ctx?.brandName ?? null
          setBrand(b)
          // Server truth says un-assumed → scrub the stale localStorage hint too, so a
          // later cross-tab 'storage' event can't re-read a stale hint and transiently flip
          // an editable card back to the placeholder. Makes the hook self-consistent instead
          // of depending on the co-mounted OperatorBanner to scrub it (mirrors AF-6).
          if (!b) clearAssumedContext()
        })
        .catch(() => { /* non-fatal — keep the optimistic value */ })
    }
    // Re-seed optimistically on mount, then reconcile against server truth.
    setBrand(getAssumedBrand())
    reconcile()
    // Cross-tab assume/exit → re-read the hint; tab focus → full server reconcile.
    const onStorage = () => setBrand(getAssumedBrand())
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', reconcile)
    return () => {
      alive = false
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', reconcile)
    }
  }, [])

  return { brand, assumed: !!brand }
}
