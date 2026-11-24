import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Route guard for /admin/fund (fund reconciliation) — GIFSY_ADMIN (assumed into a client), GIFSY_STAFF (assumed,
 * holding `payouts:read` — the admin shell's AdminRouteGuard shows AccessDenied to a staff member without it, via
 * the '/admin/fund' entry in lib/rbac/route-permissions.ts) and CLIENT_ADMIN (read-only view of their own fund).
 * Matches the `fundAdmin` nav gate in admin/layout.tsx so nav visibility and direct-URL access agree. MIS_USER and
 * the other roles are bounced to their own home. The backend independently scopes every read to the caller's tenant
 * and allows writes only with payouts:manage_fund; the page renders write controls only when the API says `canManage`.
 */
export default function FundLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN', 'GIFSY_STAFF', 'CLIENT_ADMIN']}>{children}</RequireAuth>;
}
