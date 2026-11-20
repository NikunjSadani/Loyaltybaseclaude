/**
 * Redemption report — the "About" sheet: filters used, when it was generated, every column and every placeholder
 * explained, and the data-handling notes. Pure.
 */
import type { XlsxCell } from '../../common/xlsx-stream';
import type { RedemptionReportParams } from './redemption-report.query';

export interface AboutInput {
  params: RedemptionReportParams;
  filterLine: string;
  generatedAt: string;
  orders: number;
  statusChanges: number;
  /** The tenant's level headers, lowest first. */
  hierarchyHeaders: string[];
  asmLabel: string | null;
}

export function redemptionAboutRows(a: AboutInput): XlsxCell[][] {
  const p = a.params;
  const rows: XlsxCell[][] = [
    ['Client', p.clientId],
    ['Redeemed between (IST)', `${p.from} 00:00 to ${p.to} 23:59 (India time), on the date the order was placed`],
    ['Filters', a.filterLine],
    ['Generated (IST)', a.generatedAt],
    ['Orders in this file', a.orders],
    ['Status changes in this file', a.statusChanges],
    ['', ''],
    ['WHAT THE PLACEHOLDERS MEAN', ''],
    ['Not recorded', 'The system should have this value but it was never saved for this order (e.g. older orders, or a step done outside the platform).'],
    ['Not set', 'The value has not been set yet (e.g. Value (₹) is fixed only when the member confirms the order with the OTP; Zone / Programme not filled in the outlet master).'],
    ['—', 'Does not apply to this order (e.g. courier for an e-voucher, UTR for a gift, a hierarchy level that is not on this rep\'s reporting line, a stage not reached yet).'],
    ['Skipped', 'The order moved past this stage without entering it (e.g. a cash payout goes straight from Placed to Delivered when the bank file is paid).'],
    ['Not assigned', 'The outlet has no active sales-rep assignment, so no hierarchy can be shown.'],
    ['Vacant (CODE)', 'That post in the hierarchy exists but nobody holds it (vacant / deactivated / removed). The code column shows the post code.'],
    ['System', 'The status change was made automatically (no person recorded as making it).'],
    ['', ''],
    ['SHEET "REDEMPTIONS" — ONE ROW PER ORDER', ''],
    ['Order no', 'The order number shown to the member and in the admin console.'],
    ['Redeemed on (IST)', 'When the order was placed (India time).'],
    ['Reward / Category', 'The catalogue reward and its catalogue category.'],
    ['Type', 'E-voucher (gift card, or a gift sent as a digital voucher) · Physical gift · Cash / UPI (paid to the member\'s bank or UPI).'],
    ['Brand', 'Taken from the reward\'s catalogue details when a brand is recorded there; the catalogue has no separate brand field, so most rewards read "Not recorded".'],
    ['Quantity', 'Units ordered.'],
    ['Points redeemed', 'The order\'s points cost. Points are taken only when the member confirms with the OTP; cancelled / failed / returned orders have their points refunded — see Current status.'],
    ['Value (₹)', 'The rupee value of the benefit, fixed when the member confirms the order (this is the TDS base).'],
    ['TDS deducted (₹)', 'TDS actually withheld from this order\'s cash payout. Section 194R TDS on redemptions is borne by the client (not deducted from the member), so this is normally 0; the client\'s 194R liability is in the TDS reports.'],
    ['Current status', 'Placed (waiting for the member\'s OTP) · Confirmed · Processing · Dispatched · Delivered · Cancelled · Returned · Failed.'],
    ['Redeemed by / Role / Phone', 'The outlet owner who redeemed, their outlet type as this client names it (Retailer, Wholesaler…), and the last 4 digits of their phone only.'],
    ['Outlet code / name / type, Programme, Sub-programme, City, State, Zone', 'From the outlet master (the member\'s primary outlet). The Zone and State filters match these columns.'],
  ];
  if (a.hierarchyHeaders.length) {
    rows.push([
      `${a.hierarchyHeaders.join(', ')} (+ code)`,
      'This client\'s own sales hierarchy, lowest level first: the sales rep currently assigned to the outlet, then each manager up the reporting line, with their employee code.',
    ]);
  } else {
    rows.push(['Sales hierarchy', 'This client has no sales hierarchy set up, so there are no hierarchy columns.']);
  }
  rows.push(
    ['Placed … Delivered (IST) + "by"', 'The FIRST time the order entered each stage (from its status history) and who moved it. If the history is missing, the order\'s own dispatched / delivered dates are used and "by" reads Not recorded.'],
    ['Cancelled/Returned/Failed (IST), by, reason', 'When the order was cancelled, returned or failed, who did it, and the reason recorded. Orders still open read "—".'],
    ['Days placed → delivered', 'Days (one decimal) from Placed to Delivered. "Not delivered" until it is delivered.'],
    ['Days in current stage', 'Days (one decimal) since the order last entered its current status, up to the time this file was generated.'],
    ['Fulfilled by', 'The vendor that fulfils the order, the e-voucher provider, or Gifsy.'],
    ['Courier / Tracking no / Proof of delivery', 'Physical gifts only. Proof of delivery: "Yes — open" links to the uploaded proof; "No" when none was uploaded.'],
    ['Delivery city / state / pincode', 'Physical gifts only. The street address is never included.'],
    ['Payout status / Paid on / Bank reference (UTR)', 'Cash / UPI orders only, from the bank payout made for the order. "Not created yet" = the order has not been confirmed into a payout.'],
    ['', ''],
    ['SHEET "STATUS HISTORY"', 'One row per status change of the orders above: from, to, when (IST), by whom and the note recorded.'],
    [
      'SHEET "SUMMARY"',
      `Orders, points and rupees by zone, state, ${a.asmLabel ? `${a.asmLabel} (the ASM level)` : 'ASM level (not shown — this client has no ASM level)'}, reward, status, reward type and delivery stage. "All orders" includes placed-but-not-confirmed and cancelled orders; "confirmed to delivered" counts only orders that took points and were not cancelled / returned / failed. Average days placed → delivered is over delivered orders only.`,
    ],
    ['', ''],
    ['DATA HANDLING', ''],
    ['Never included', 'Voucher codes and PINs, PAN, full phone numbers, delivery name / phone / street address, and bank details are never read into or written to this file.'],
    ['Audit', 'Every download of this report is recorded (who, client, row count and filters).'],
    ['Who can download', 'Gifsy admins and client admins. A client admin only ever gets their own client\'s orders.'],
  );
  return rows;
}
