'use client';

// This route is an orphan — nothing in the app navigates here.
// The live outlet page lives at /admin/users/outlets.
// Redirect any direct visit there to avoid confusion.
//
// NOTE: a SERVER-component `redirect()` here was silently swallowed by the enclosing
// `'use client'` admin layout in this Next build — the NEXT_REDIRECT surfaced as the
// admin error boundary (HTTP 200 error page) instead of performing the redirect. A
// client-side `router.replace` is robust under the client layout.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function OutletsOrphanRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/users/outlets');
  }, [router]);
  return null;
}
