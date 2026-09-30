import { RequireAuth } from '@/components/auth/require-auth';

/**
 * Q1: payout management is a GIFSY-OPERATOR capability. Guarding the payout pages to
 * GIFSY_ADMIN + GIFSY_STAFF means a CLIENT_ADMIN / MIS_USER who navigates here directly is
 * bounced to their own home (getRoleHome → /admin/dashboard), while an assumed GIFSY_STAFF is
 * admitted (was excluded → redirect LOOP). The backend is @Roles('GIFSY_ADMIN') +
 * @RequirePermission: reads need `payouts:read`; funding/processing/reconcile need
 * `payouts:manage_fund`/`payouts:process_batch`/`payouts:reconcile` — so a staff with only
 * `payouts:read` can view batches but not execute. Pairs with the nav being gifsyOnly.
 */
export default function PayoutsLayout({ children }: { children: React.ReactNode }) {
  return <RequireAuth allowedRoles={['GIFSY_ADMIN', 'GIFSY_STAFF']}>{children}</RequireAuth>;
}
