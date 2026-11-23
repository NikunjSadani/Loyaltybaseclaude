'use client';

// RETIRED (fund reconciliation, 2026-11-23): the old "Fund Management" screen showed wrong fields, stored
// receipts ×100 and made up a low-balance threshold. It is replaced by /admin/fund (FUND-RECONCILIATION-DESIGN.md).
// Any bookmark / direct visit is sent there.
//
// Client-side `router.replace` (not a server `redirect()`): in this Next build a server redirect inside the
// `'use client'` admin layout surfaces as the admin error boundary instead of redirecting — the same reason
// /admin/approvals and /admin/outlets use this pattern. `replace` keeps the dead URL out of the Back history.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function RetiredFundManagementRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/fund');
  }, [router]);
  return null;
}
