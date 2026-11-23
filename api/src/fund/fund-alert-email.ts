/**
 * The once-a-day LOW BALANCE e-mail to a client's configured recipients (fund reconciliation, decision 7: alerts only,
 * spend is never blocked). Pure — reuses the scheduled-report HTML helpers (every value escaped).
 */
import { emailShell, esc, rupees, statRow } from '../reports/scheduled/email-html';

export interface LowBalanceEmailInput {
  clientName: string;
  dateLabel: string;
  balancePaise: bigint;
  committedPaise: bigint;
  thresholdPaise: bigint;
}

export function buildLowBalanceEmail(i: LowBalanceEmailInput): { subject: string; html: string } {
  const subject = `Low fund balance — ${i.clientName}: ${rupees(i.balancePaise)} (below ${rupees(i.thresholdPaise)})`;
  const body =
    statRow([
      { label: 'Balance', value: rupees(i.balancePaise), accent: 'red' },
      { label: 'Committed, not yet paid', value: rupees(i.committedPaise), accent: 'amber' },
      { label: 'Alert threshold', value: rupees(i.thresholdPaise) },
    ]) +
    `<p style="font-size:14px;line-height:1.5;color:#1f2937">The program fund for <b>${esc(i.clientName)}</b> is below the alert ` +
    `threshold. The balance already deducts vouchers and payouts that are committed but not yet paid. ` +
    `Nothing is blocked — rewards and payouts continue; please arrange a top-up of the advance.</p>` +
    `<p style="font-size:13px;color:#6b7280">You get this e-mail at most once a day while the balance stays below the threshold. ` +
    `The full statement is under Fund Reconciliation in the admin portal.</p>`;
  return {
    subject,
    // emailShell escapes intro itself.
    html: emailShell({
      title: 'Low fund balance',
      intro: i.clientName,
      body,
      dateLabel: i.dateLabel,
      footerText: 'Automated alert from Gifsy. Do not reply.',
    }),
  };
}
