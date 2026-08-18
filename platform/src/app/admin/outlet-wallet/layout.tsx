import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Outlet Wallet (points balance + passbook + manual adjust) is a GIFSY-only tool — it
 * reads/writes any outlet's POINTS wallet in the current (assumed) tenant and performs a
 * money-adjacent manual credit/debit. Guarding the page to GIFSY_ADMIN means a tenant admin
 * who navigates here directly is bounced to their own home (getRoleHome → /admin/dashboard)
 * rather than seeing wallet management. Pairs with the nav being hidden (gifsyOnly) and the
 * backend endpoints being narrowed to GIFSY_ADMIN. Mirrors admin/payouts/layout.tsx.
 */
export default function OutletWalletLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN']}>{children}</RequireAuth>;
}
