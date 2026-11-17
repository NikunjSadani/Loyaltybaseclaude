'use client';

// RETIRED (A2): this route used to render an unlinked "KYC Approvals" page that listed PENDING_GIFSY
// KYCs but whose Approve/Reject buttons only changed local state — nothing was ever saved. The real
// GIFSY review queue is /admin/kyc/approvals. Any bookmark / direct visit is sent there.
//
// Client-side `router.replace` (not a server `redirect()`): in this Next build a server redirect inside
// the `'use client'` admin layout surfaces as the admin error boundary (HTTP 200 error page) instead of
// redirecting — the same reason /admin/outlets uses this pattern. `replace` keeps the dead URL out of
// the Back history.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminApprovalsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin/kyc/approvals');
  }, [router]);
  return null;
}
