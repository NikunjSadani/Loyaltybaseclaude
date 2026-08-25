import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Route guard for /admin/notification-delivery — GIFSY_ADMIN (all tenants / assumed) +
 * CLIENT_ADMIN (own tenant, BE-scoped). Matches the `deliveryReport` nav flag in
 * admin/layout.tsx so nav visibility and the route guard admit exactly the same roles
 * (no "nav shown but URL blocked" gap). The backend independently HARD-scopes every read
 * to the caller's tenant — this guard only controls page access.
 */
export default function NotificationDeliveryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RequireAuth allowedRoles={['GIFSY_ADMIN', 'CLIENT_ADMIN']}>{children}</RequireAuth>
  );
}
