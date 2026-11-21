'use client';

/**
 * Request-volume work (2026-11-21) — the sales app's links do NOT prefetch automatically.
 *
 * Why: every page here is dynamic (the root layout reads request headers for the tenant), and Next 16 re-schedules
 * a prefetch for EVERY visible <Link> after EVERY navigation (client/components/links.js `pingVisibleLinks`). An
 * outlet list therefore re-requested every visible outlet's detail RSC on each screen change (/sales/kyc/:id ≈ 2,229
 * prefetches per 80 min in prod) and the always-visible header/bottom-nav links were re-prefetched on every render.
 *
 * What replaces it:
 *   • List rows (outlets, KYC submissions, team members) load on tap; `LinkPendingHint` dims the tapped row at once
 *     and `app/sales/kyc/[id]/loading.tsx` shows the detail skeleton while the route streams in.
 *   • Bottom-nav / header menu targets are prefetched ONCE per app session by `usePrefetchOnce`
 *     (lib/navigation/prefetch-once.ts), so tab switches stay as fast as before without a prefetch per render.
 *
 * A call site may still pass `prefetch` explicitly to opt back in. Docs: node_modules/next/dist/docs/01-app/02-guides/prefetching.md
 * ("Disabled prefetch" / "Preventing too many prefetches").
 */
import React from 'react';
import Link, { useLinkStatus } from 'next/link';

export type NoPrefetchLinkProps = React.ComponentProps<typeof Link>;

export function NoPrefetchLink(props: NoPrefetchLinkProps) {
  return <Link prefetch={false} {...props} />;
}

export default NoPrefetchLink;

/** True while the enclosing <Link>'s navigation is pending. Never throws (false outside a Link / in test mocks). */
function useLinkPending(): boolean {
  try {
    // `useLinkStatus` is always present at runtime (Next ≥15.3). Unit tests that vi.mock('next/link') without it
    // throw on access — that throw is consistent across renders, so the hook order never changes.
    return useLinkStatus().pending;
  } catch {
    return false;
  }
}

/**
 * Instant tap feedback for a non-prefetched link: a light pulsing veil over the row while the next screen loads.
 * Place it INSIDE the <Link>; the link needs `relative` positioning.
 */
export function LinkPendingHint() {
  const pending = useLinkPending();
  if (!pending) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="link-pending-hint"
      className="pointer-events-none absolute inset-0 rounded-[inherit] bg-white/60 animate-pulse"
    />
  );
}
