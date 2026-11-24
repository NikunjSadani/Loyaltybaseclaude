'use client';

import { usePathname } from 'next/navigation';
import { RequireAuth } from '@/components/auth/require-auth';

/** The retired Fund Management URL — its page only redirects to /admin/fund (which has its own role guard). */
const RETIRED_FUND_PATH = '/admin/payouts/fund';

/**
 * Q1: payout management is a GIFSY-OPERATOR capability. Guarding the payout pages to
 * GIFSY_ADMIN + GIFSY_STAFF means a CLIENT_ADMIN / MIS_USER who navigates here directly is
 * bounced to their own home (getRoleHome → /admin/dashboard), while an assumed GIFSY_STAFF is
 * admitted (was excluded → redirect LOOP). The backend is @Roles('GIFSY_ADMIN') +
 * @RequirePermission: reads need `payouts:read`; funding/processing/reconcile need
 * `payouts:manage_fund`/`payouts:process_batch`/`payouts:reconcile` — so a staff with only
 * `payouts:read` can view batches but not execute. Pairs with the nav being gifsyOnly.
 *
 * C13 (fund reconciliation): an old /admin/payouts/fund bookmark must reach /admin/fund for a CLIENT_ADMIN too, so
 * that one path skips this guard — its page renders nothing and only redirects; /admin/fund's own guard then
 * admits GIFSY_ADMIN / GIFSY_STAFF / CLIENT_ADMIN and still bounces MIS_USER.
 */
export default function PayoutsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === RETIRED_FUND_PATH || pathname === `${RETIRED_FUND_PATH}/`) {
    return <RequireAuth>{children}</RequireAuth>;
  }
  return <RequireAuth allowedRoles={['GIFSY_ADMIN', 'GIFSY_STAFF']}>{children}</RequireAuth>;
}
