'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken, getStoredUser, getRoleHome } from '@/lib/auth-client';

/**
 * Client-side route guard. Renders its children only when (a) a session token is present and
 * (b) — when `allowedRoles` is given — the logged-in user's role is admitted by this portal.
 * Otherwise it redirects: no token → /auth/login; wrong role → the user's OWN home (keeping the
 * session, so it's an authz bounce, not a logout). Wrap each portal layout's content with it and
 * pass that portal's roles (gap #41 — a role must not load another portal).
 *
 * Auth is a localStorage Bearer token (the backend reads Authorization: Bearer), so guarding must
 * run client-side — a server middleware cannot see localStorage.
 */
export function RequireAuth({
  children,
  allowedRoles,
}: {
  children: React.ReactNode;
  allowedRoles?: string[];
}) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  // Stable dep so an inline array prop doesn't churn the effect.
  const rolesKey = allowedRoles ? allowedRoles.join(',') : '';

  useEffect(() => {
    if (!getToken()) {
      router.replace('/auth/login');
      return;
    }
    if (rolesKey) {
      const role = getStoredUser()?.role;
      if (!role || !rolesKey.split(',').includes(role)) {
        router.replace(getRoleHome(role));
        return;
      }
    }
    setReady(true);
  }, [router, rolesKey]);

  if (!ready) return null;
  return <>{children}</>;
}
