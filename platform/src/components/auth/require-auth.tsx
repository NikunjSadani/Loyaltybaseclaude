'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/auth-client';

/**
 * Client-side route guard. Renders its children only when a session token is
 * present in localStorage; otherwise redirects to /auth/login. Wrap the page
 * content area of each portal layout (admin/partner/sales/gifsy) with it.
 *
 * Auth is a localStorage Bearer token (the backend reads Authorization: Bearer),
 * so guarding must run client-side — a server middleware cannot see localStorage.
 */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/auth/login');
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return null;
  return <>{children}</>;
}
