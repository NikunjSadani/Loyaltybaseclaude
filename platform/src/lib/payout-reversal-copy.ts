/**
 * payout-reversal-copy.ts — shared wording for payout reversals (request modal on the Payout Status page,
 * pending / processed reversals and bank-file notices on the Payout Download page). One source so both
 * screens tell the operator the same thing about the same entry.
 */
import { formatInrPaise } from './money-format';

/** Shown on a held / selectable entry that is with the bank right now: approval must wait for the bank result. */
export const PROCESSING_BLOCK_TEXT = 'Waiting for the bank result on an entry — record the UTR or the failure first';

/** What reversing a payout entry does, by its current bank status. */
export const ENTRY_STATUS_TEXT: Record<string, string> = {
  PENDING:    'Not yet sent to the bank — will be cancelled',
  FAILED:     'Bank payment failed — will be cancelled',
  PROCESSING: 'With the bank now — approval waits for the bank result (record the UTR or the failure first)',
  PAID:       'Already paid — becomes owed (net of TDS withheld) · withheld TDS becomes a TDS credit',
  CANCELLED:  'Cancelled by Gifsy (never paid)',
};

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/**
 * One sentence for an already-paid entry that became owed: the net amount owed back, the TDS withheld from it
 * and the TDS credit carried on the PAN. A fully-withheld entry says so honestly (₹0.00 owed back).
 */
export function PAID_ENTRY_OUTCOME(netPaise: number, tdsWithheldPaise: number, creditPaise: number): string {
  const credit = creditPaise > 0 ? `${formatInrPaise(creditPaise)} TDS credit` : '';
  if (netPaise <= 0 && tdsWithheldPaise > 0) {
    return `${formatInrPaise(0)} owed back — the whole amount was withheld as TDS${credit ? `; ${credit}` : ''}`;
  }
  return [
    `Owed back · ${formatInrPaise(netPaise)}${tdsWithheldPaise > 0 ? ` (net of ${formatInrPaise(tdsWithheldPaise)} TDS withheld)` : ''}`,
    ...(credit ? [credit] : []),
  ].join(' · ');
}

/** Bank file: entries a pending reversal kept out of the file. */
export function HELD_NOTICE(count: number, paise: number): string {
  return (
    `${count} payout ${plural(count, 'entry', 'entries')} (${formatInrPaise(paise)}) ` +
    `${plural(count, 'was', 'were')} held out of this bank file because a reversal request is pending — ` +
    'see Pending Reversal Requests below. Approve or reject each request; a rejected request releases its entries into the next file.'
  );
}

/** Bank file: TDS covered by an earlier TDS credit (TDS already deposited for a reversed payout on the same PAN). */
export function TDS_CREDIT_NOTICE(count: number, paise: number): string {
  return (
    `${formatInrPaise(paise)} of TDS on ${count} payout ${plural(count, 'entry was', 'entries were')} ` +
    'adjusted from earlier TDS credit (TDS already deposited for a reversed payout on the same PAN) — ' +
    'less TDS was withheld from those retailers in this file. Details: TDS payout report → TDS credits.'
  );
}

/** Bank file: TDS handed back because a reversal brought the PAN below the TDS limit. */
export function TDS_ADJUSTMENT_NOTICE(count: number, paise: number): string {
  return (
    `${formatInrPaise(paise)} less TDS on ${count} payout ${plural(count, 'entry', 'entries')}: ` +
    'adjusted after a reversal brought the PAN below the TDS limit — the TDS already deducted was handed back in this file.'
  );
}
