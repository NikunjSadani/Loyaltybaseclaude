'use client';

/**
 * /admin/gift-disbursal — the Gift Disbursal report.
 *
 * Gate: GIFSY_ADMIN (all tenants/vendors) AND CLIENT_ADMIN (their OWN tenant only —
 * this is the single gift screen a tenant admin sees). GIFSY_STAFF and MIS_USER are
 * NOT admitted, matching the nav predicate in admin/layout.tsx (no shown-but-blocked
 * gap). The backend is the real enforcement + tenant scoping; RequireAuth is
 * defence-in-depth + a clean authz bounce (renders null until the check passes → no
 * flash-of-content).
 */

import { RequireAuth } from '@/components/auth/require-auth';

export default function GiftDisbursalLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth allowedRoles={['GIFSY_ADMIN', 'CLIENT_ADMIN']}>{children}</RequireAuth>
  );
}
