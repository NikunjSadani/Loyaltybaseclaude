import { formatPoints } from '@/lib/utils';
import type { WalletBalance } from '@/types';

/**
 * Owner decision 2 (2026-11-19 — the retailer sees a negative balance as it is): the shared wording for a negative
 * wallet, used by the partner BalanceCard, the sales outlet view (OutletWalletView) and the admin outlet wallet.
 */

/** Points with a real minus sign for a negative value ("−2,986"). */
export function formatSignedPoints(n: number): string {
  return n < 0 ? `−${formatPoints(-n)}` : formatPoints(n);
}

/** What a negative wallet owes, in plain words. Null for a balance at 0 or above. */
export function negativeBalanceNote(
  balance: Pick<WalletBalance, 'redeemable' | 'owedPoints' | 'owedFromReversal'>,
): string | null {
  if (!(balance.redeemable < 0)) return null;
  const owed = balance.owedPoints ?? -balance.redeemable;
  return `You owe ${formatPoints(owed)} pts${balance.owedFromReversal ? ' from a reversed credit' : ''} — it's repaid from your next earnings.`;
}
