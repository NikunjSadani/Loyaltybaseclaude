import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Outlet Wallet (points balance + passbook + manual adjust) is a GIFSY-OPERATOR tool — it
 * reads/writes any outlet's POINTS wallet in the current (assumed) tenant and performs a
 * money-adjacent manual credit/debit. Guarding the page to GIFSY_ADMIN + GIFSY_STAFF means a
 * tenant admin who navigates here directly is bounced to their own home (getRoleHome →
 * /admin/dashboard), while an assumed GIFSY_STAFF is admitted (was excluded → redirect LOOP).
 * The backend is @Roles('GIFSY_ADMIN') + @RequirePermission: reads need `wallet:read`, the
 * manual adjust needs `wallet:adjust` — so a staff without `wallet:adjust` can view but not
 * adjust. Pairs with the nav being gifsyOnly. Mirrors admin/payouts/layout.tsx.
 */
export default function OutletWalletLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN', 'GIFSY_STAFF']}>{children}</RequireAuth>;
}
