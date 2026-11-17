'use client';

// RETIRED (A2): this route used to render an unlinked "KYC Approvals" page that listed PENDING_GIFSY
// KYCs but whose Approve/Reject buttons only changed local state — nothing was ever saved. Any bookmark /
// direct visit is sent, by role (R5), to the real surface:
//   - GIFSY operators (GIFSY_ADMIN / GIFSY_STAFF) → /admin/kyc/approvals, the GIFSY review queue;
//   - everyone else (CLIENT_ADMIN, MIS_USER, no session) → /admin/kyc. A CLIENT_ADMIN must never use the
//     GIFSY queue (DATA-VISIBILITY §3 Q2; e2e/clientAdmin/scoping.e2e.ts).
// The role is the logged-in JWT user read in the effect (client-only) — NOT useAdminSession(), whose
// pre-hydration placeholder is CLIENT_ADMIN and would misroute a GIFSY operator on the first paint.
//
// Client-side `router.replace` (not a server `redirect()`): in this Next build a server redirect inside
// the `'use client'` admin layout surfaces as the admin error boundary (HTTP 200 error page) instead of
// redirecting — the same reason /admin/outlets uses this pattern. `replace` keeps the dead URL out of
// the Back history.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getStoredUser } from '@/lib/auth-client';

const GIFSY_ROLES = new Set(['GIFSY_ADMIN', 'GIFSY_STAFF']);

export default function AdminApprovalsRedirect() {
  const router = useRouter();
  useEffect(() => {
    const role = getStoredUser()?.role;
    router.replace(role && GIFSY_ROLES.has(role) ? '/admin/kyc/approvals' : '/admin/kyc');
  }, [router]);
  return null;
}
