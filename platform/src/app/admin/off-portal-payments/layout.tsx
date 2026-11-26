import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Route guard for /admin/off-portal-payments (the off-portal payments register) — GIFSY_ADMIN (assumed into a client;
 * the only role that can upload / void) and CLIENT_ADMIN (read-only register, PII masked). Matches the backend
 * @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN') on the read routes and the `offPortalAdmin` nav gate in admin/layout.tsx, so nav
 * visibility and direct-URL access agree. GIFSY_STAFF / MIS_USER are bounced to their own home (the API refuses them).
 * The page renders upload / void controls only when the API says `canWrite`; the backend enforces it regardless.
 */
export default function OffPortalPaymentsLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN', 'CLIENT_ADMIN']}>{children}</RequireAuth>;
}
