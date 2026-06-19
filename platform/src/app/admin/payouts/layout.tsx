import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Q1: payout management is GIFSY-only. This portal is for CLIENT_ADMIN/MIS, so guarding the payout
 * pages to GIFSY_ADMIN means a tenant admin who navigates here directly is bounced to their own home
 * (getRoleHome → /admin/dashboard) rather than seeing payout management. Pairs with the nav being
 * hidden (gifsyOnly) and the backend endpoints being narrowed to GIFSY_ADMIN.
 */
export default function PayoutsLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN']}>{children}</RequireAuth>;
}
