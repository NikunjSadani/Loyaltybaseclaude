import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Gift Dispatch console — the platform-wide gift-fulfilment oversight surface: it lists
 * gift redemption orders ACROSS ALL tenants (design §2/§5), which is owner territory.
 * Per RBAC Option-X an un-assumed GIFSY_STAFF is NOT platform-wide, so a cross-tenant
 * "all tenants" console is guarded to GIFSY_ADMIN — the same posture as the WhatsApp
 * Broadcasts owner console. Any other role (CLIENT_ADMIN / MIS_USER / GIFSY_STAFF) who
 * navigates here directly is bounced to their own home rather than hitting a wall of
 * 403s. The nav entry is gated to GIFSY_ADMIN too (gifsyAdminOnly in admin/layout.tsx)
 * so nav visibility and this guard agree — no "nav shown but URL blocked" gap.
 * The backend remains the real enforcement of the cross-tenant scope.
 */
export default function GiftOrdersLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN']}>{children}</RequireAuth>;
}
