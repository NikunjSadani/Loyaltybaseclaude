'use client';

import { useEffect, useState } from 'react';

/**
 * The AUTHORITATIVE tenant slug for the signed-in session — the JWT `clientId` from `/auth/me`.
 * Returns `null` until it resolves (and on an unauthenticated session or a failed call).
 *
 * WHY THIS EXISTS: the SSR tenant config (`useClientConfig`) is resolved from the request host and
 * silently degrades to the neutral `'default'` config for DB-provisioned tenants whenever the
 * `x-tenant-slug` header is absent (no live Next middleware sets it — only the external edge proxy
 * does). Any tenant-specific UI keyed on the slug (e.g. Bajaj's ISR/SM/ZH hierarchy column headers)
 * must therefore PREFER this authenticated value, falling back to the SSR slug until it resolves.
 * It is also correct for a GIFSY operator assumed into a tenant (clientId = the assumed tenant).
 *
 * Usage: `const slug = useAuthClientId() ?? useClientConfig().slug;`
 */
export function useAuthClientId(): string | null {
  const [clientId, setClientId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        // /auth/me returns the global `{ success, data }` envelope — clientId lives at
        // j.data.clientId (fall back to a flat shape defensively).
        const cid = j?.data?.clientId ?? j?.clientId;
        if (alive && cid) setClientId(String(cid));
      })
      .catch(() => {
        /* fall back to the SSR slug */
      });
    return () => {
      alive = false;
    };
  }, []);
  return clientId;
}
