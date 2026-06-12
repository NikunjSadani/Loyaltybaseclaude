/**
 * /partner/payouts — permanently replaced by /partner/wallet.
 * This redirect ensures any bookmarked or linked URLs still work.
 */
import { redirect } from 'next/navigation';

export default function PayoutsRedirectPage() {
  redirect('/partner/wallet');
}
