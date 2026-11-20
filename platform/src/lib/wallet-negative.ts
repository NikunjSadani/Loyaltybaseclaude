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

/**
 * Owner decision D2 (2026-11-19, every tenant): the one-line explanation next to any liability figure when some wallets
 * are below zero. Null when nothing is owed (a tenant with no negative wallet renders exactly as before).
 */
export function liabilitySplitNote(owedPoints: number | undefined, owedWallets: number | undefined): string | null {
  const owed = owedPoints ?? 0;
  if (!(owed > 0)) return null;
  const n = owedWallets ?? 0;
  // Fix round 4 (item 6): it counts WALLETS, and this line is often the only place the figure appears — so it says
  // "not included", never "shown separately".
  return `Liability counts positive balances only — ${formatPoints(owed)} pts owed by ${formatPoints(n)} wallet${n === 1 ? '' : 's'} with a negative balance ${n === 1 ? 'is' : 'are'} not included.`;
}

/** Who reads the note: the retailer ("You owe …") or Gifsy / sales / client staff looking at an outlet (B6). */
export type NoteAudience = 'partner' | 'staff';

/** What a negative wallet owes, in plain words. Null for a balance at 0 or above. */
export function negativeBalanceNote(
  balance: Pick<WalletBalance, 'redeemable' | 'owedPoints' | 'owedFromReversal'>,
  audience: NoteAudience = 'partner',
): string | null {
  if (!(balance.redeemable < 0)) return null;
  const owed = formatPoints(balance.owedPoints ?? -balance.redeemable);
  const why = balance.owedFromReversal ? ' from a reversed credit' : '';
  return audience === 'staff'
    ? `This outlet owes ${owed} pts${why} — repaid from its next earnings; it can't redeem until its balance is back above zero.`
    : `You owe ${owed} pts${why} — it's repaid from your next earnings.`;
}
