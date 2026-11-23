import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Route guard for /admin/fund (fund reconciliation) — GIFSY_ADMIN (assumed into a client; manages receipts,
 * adjustments, rates) + CLIENT_ADMIN (read-only view of their own fund). Matches the `fundAdmin` nav gate in
 * admin/layout.tsx so nav visibility and direct-URL access agree. GIFSY_STAFF / MIS_USER are bounced to their
 * own home, the same as the other GIFSY_ADMIN + CLIENT_ADMIN pages (offers, sales import). The backend
 * independently scopes every read to the caller's tenant and allows writes to Gifsy only; the page renders
 * write controls only when the API says `canManage`.
 */
export default function FundLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN', 'CLIENT_ADMIN']}>{children}</RequireAuth>;
}
