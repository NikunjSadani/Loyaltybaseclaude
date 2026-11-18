import * as fs from 'fs';
import * as path from 'path';
import {
  attentionItems,
  buildDailyOpsDigest,
  digestWindow,
  failedSections,
  gifsyWideAttention,
  gifsyWideItems,
  kycPendingBuckets,
  needsAttention,
} from './daily-ops-digest-report';
import type { DigestInput, SectionResult, TenantDigest } from './report.types';

const IST = 330 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Build a UTC-ms instant from an IST wall-clock. */
const ist = (y: number, mo: number, d: number, h = 9, mi = 30) => Date.UTC(y, mo - 1, d, h, mi) - IST;
const ok = <T,>(data: T): SectionResult<T> => ({ ok: true, data });

const zeroBucket = { pending: 0, within: 0, nearing: 0, breached: 0 };

/** A tenant with every section loaded and empty. */
function quietTenant(clientId: string, name: string): TenantDigest {
  return {
    clientId,
    name,
    kyc: ok({
      submitted: 0,
      approved: 0,
      rejected: 0,
      field: { ...zeroBucket },
      gifsy: { ...zeroBucket },
      gifsyFastTracked: 0,
      fieldFastTrackedExcluded: 0,
    }),
    points: ok({ credited: 0, redeemed: 0, expired: 0, negativeWallets: 0 }),
    redemptions: ok({ requested: 0, completed: 0, failed: 0, failedNotRefunded: 0, failedRows: [] }),
    payouts: ok({
      batchesConfirmed: 0,
      batchPoints: 0,
      batchOutlets: 0,
      batchPayoutPaise: 0n,
      creditPaid: 0,
      creditPaidPaise: 0n,
      redemptionPaid: 0,
      redemptionPaidPaise: 0n,
      failedOrReturned: 0,
      awaitingUtr: 0,
      awaitingUtrPaise: 0n,
      openFailedCredit: 0,
      openFailedCreditPaise: 0n,
      openFailedRedemption: 0,
    }),
    messages: ok({ otpFailed: 0, smsFailed: 0, whatsappFailed: 0, broadcastFailed: 0 }),
  };
}

/** Realistic busy tenant (Bajaj-like: Hubble + Sales Import + Visibility). */
function busyTenant(): TenantDigest {
  return {
    clientId: 'bajaj',
    name: 'Bajaj Consumer Care',
    kyc: ok({
      submitted: 46,
      approved: 31,
      rejected: 4,
      field: { pending: 58, within: 30, nearing: 16, breached: 12 },
      gifsy: { pending: 21, within: 18, nearing: 1, breached: 2 },
      gifsyFastTracked: 3,
      fieldFastTrackedExcluded: 0,
    }),
    points: ok({ credited: 184250, redeemed: 96400, expired: 1200, negativeWallets: 5 }),
    redemptions: ok({
      requested: 37,
      completed: 29,
      failed: 3,
      failedNotRefunded: 0,
      failedRows: [
        { outlet: 'Shree Ganesh Traders (BJ-10421)', reward: 'Amazon Pay Voucher ₹500', reason: 'Hubble: insufficient balance' },
        { outlet: 'Maa Durga General Store (BJ-22870)', reward: 'Amazon Pay Voucher ₹1,000', reason: 'Hubble: product unavailable' },
        { outlet: 'Patel & Sons <Wholesale> (BJ-31002)', reward: 'Bank transfer ₹2,000', reason: 'Beneficiary account closed' },
      ],
    }),
    vouchers: ok({ issued: 22, failed: 2, stuckProcessing: 1, needsReconcile: 0 }),
    payouts: ok({
      batchesConfirmed: 2,
      batchPoints: 184250,
      batchOutlets: 412,
      batchPayoutPaise: 1_25_000_00n,
      creditPaid: 412,
      creditPaidPaise: 8_43_500_00n,
      redemptionPaid: 9,
      redemptionPaidPaise: 18_000_00n,
      failedOrReturned: 3,
      awaitingUtr: 120,
      awaitingUtrPaise: 2_40_000_00n,
      openFailedCredit: 4,
      openFailedCreditPaise: 8_000_00n,
      openFailedRedemption: 0,
    }),
    messages: ok({ otpFailed: 5, smsFailed: 0, whatsappFailed: 3, broadcastFailed: 0 }),
    visibility: ok({ submitted: 140, approved: 118, rejected: 9, pending: 63 }),
    salesImport: ok({
      processed: 1,
      failed: 0,
      failedOpen: 0,
      openMonths: [
        { month: '2026-11', lastAppliedAtMs: ist(2026, 11, 12, 18, 5), targetsChangedSinceApply: true },
        { month: '2026-10', lastAppliedAtMs: ist(2026, 11, 3, 11, 0), targetsChangedSinceApply: false },
      ],
    }),
    billing: ok({
      month: '2026-11',
      kpiLabel: 'Total Sales',
      asOf: '2026-11-12',
      withTarget: 6417,
      notStarted: 1840,
      noTarget: 35,
      notCovered: 0,
      targetsOutsideRoster: 2,
    }),
  };
}

/** Gifsy-wide voucher dispersal with problems. */
const busyDispersal = () =>
  ok({ bought: 180, buyFailed: 2, messageFailed: 4, pending: 12, pendingRetryable: 1, buyFailedOpen: 3, messageFailedOpen: 4 });
const zeroDispersal = () =>
  ok({ bought: 0, buyFailed: 0, messageFailed: 0, pending: 0, pendingRetryable: 0, buyFailedOpen: 0, messageFailedOpen: 0 });

const NOW = ist(2026, 11, 13); // Fri 13 Nov 2026, 09:30 IST

function input(tenants: TenantDigest[], extra: Partial<DigestInput> = {}): DigestInput {
  return { window: digestWindow(NOW), dateLabel: '13 Nov 2026', tenants, ...extra };
}

describe('digestWindow', () => {
  it('Tue–Sat: the last 24 h', () => {
    const tue = ist(2026, 11, 17);
    expect(digestWindow(tue)).toEqual({
      startMs: tue - 24 * HOUR,
      endMs: tue,
      label: 'Mon 16 Nov, 09:30 → Tue 17 Nov, 09:30 IST',
    });
    const sat = ist(2026, 11, 14);
    expect(digestWindow(sat).startMs).toBe(sat - 24 * HOUR);
    expect(digestWindow(sat).label).toBe('Fri 13 Nov, 09:30 → Sat 14 Nov, 09:30 IST');
  });

  it('Monday: reaches back to Saturday at the same time (covers Sunday)', () => {
    const mon = ist(2026, 11, 16);
    const w = digestWindow(mon);
    expect(w.startMs).toBe(mon - 48 * HOUR);
    expect(w.label).toBe('Sat 14 Nov, 09:30 → Mon 16 Nov, 09:30 IST');
  });

  it('uses the IST weekday, not the UTC one, at the day boundary', () => {
    // Mon 00:10 IST = Sun 18:40 UTC → still Monday in IST → 48 h.
    const monEarly = ist(2026, 11, 16, 0, 10);
    expect(new Date(monEarly).getUTCDay()).toBe(0);
    expect(digestWindow(monEarly).startMs).toBe(monEarly - 48 * HOUR);
    // Sun 23:50 IST = Sun 18:20 UTC → Sunday → 24 h.
    const sunLate = ist(2026, 11, 15, 23, 50);
    expect(digestWindow(sunLate).startMs).toBe(sunLate - 24 * HOUR);
  });
});

describe('kycPendingBuckets (reuses the two-stage business-hours SLA)', () => {
  const targets = { fieldHrs: 24, gifsyHrs: 96 };
  // Fri 13 Nov 2026 18:00 IST — the business clock counts Mon–Fri, so Thu/Fri submissions age normally.
  const now = ist(2026, 11, 13, 18, 0);

  it('splits field vs Gifsy and within / nearing / breached', () => {
    const rows = [
      { status: 'SUBMITTED', submittedAt: new Date(now - 2 * HOUR) }, // field, 2h → within
      { status: 'PENDING_SO_APPROVAL', submittedAt: new Date(now - 20 * HOUR) }, // field, 20h → nearing (≥18)
      { status: 'PENDING_ASM_APPROVAL', submittedAt: new Date(ist(2026, 11, 9, 9, 0)) }, // field, ~105h → breached
      {
        status: 'PENDING_GIFSY',
        submittedAt: new Date(ist(2026, 11, 2, 9, 0)),
        statusHistory: [{ toStatus: 'PENDING_GIFSY', createdAt: new Date(now - 3 * HOUR) }],
      }, // gifsy, 3h → within
      { status: 'APPROVED', submittedAt: new Date(now - 3 * HOUR) }, // decided → ignored
      { status: 'DRAFT', submittedAt: null }, // none → ignored
    ];
    const { field, gifsy } = kycPendingBuckets(rows, targets, new Set(), now);
    expect(field).toEqual({ pending: 3, within: 1, nearing: 1, breached: 1 });
    expect(gifsy).toEqual({ pending: 1, within: 1, nearing: 0, breached: 0 });
  });

  it('compares UNROUNDED business hours (dashboard rule): 24 h 20 min against a 24 h target is breached', () => {
    // Fri 18:00 − 24h20m of business time = Thu 17:40 (Thu+Fri are business days).
    const rows = [{ status: 'SUBMITTED', submittedAt: new Date(now - (24 * 60 + 20) * 60 * 1000) }];
    // Math.round(24.33) = 24 would have read "not breached" (24 > 24 is false) — the dashboard says breached.
    expect(kycPendingBuckets(rows, targets, new Set(), now).field).toEqual({ pending: 1, within: 0, nearing: 0, breached: 1 });
    // Exactly at the target is still within (age ≤ target), counted as nearing.
    const atTarget = [{ status: 'SUBMITTED', submittedAt: new Date(now - 24 * HOUR) }];
    expect(kycPendingBuckets(atTarget, targets, new Set(), now).field).toEqual({ pending: 1, within: 0, nearing: 1, breached: 0 });
  });

  it('a PENDING_GIFSY row with no Gifsy history ages from submittedAt, else createdAt (dashboard fallback)', () => {
    const rows = [{ status: 'PENDING_GIFSY', submittedAt: null, createdAt: new Date(ist(2026, 11, 2, 9, 0)), statusHistory: [] }];
    expect(kycPendingBuckets(rows, targets, new Set(), now).gifsy.breached).toBe(1);
  });

  it('holidays pause the clock (a holiday-spanning field row is not breached)', () => {
    const rows = [{ status: 'SUBMITTED', submittedAt: new Date(ist(2026, 11, 12, 9, 0)) }]; // Thu 09:00 → Fri 18:00
    expect(kycPendingBuckets(rows, targets, new Set(), now).field.breached).toBe(1); // 33h > 24
    expect(kycPendingBuckets(rows, targets, new Set(['2026-11-12']), now).field.breached).toBe(0);
  });

  const FT_ROW = {
    fromStatus: 'DRAFT',
    toStatus: 'PENDING_GIFSY',
    metadata: { fastTrack: 'GIFSY_REJECT_RESUBMISSION' },
    createdAt: new Date(now - 2 * HOUR),
  };

  it('fast-track: a fast-tracked KYC at Gifsy is on the Gifsy clock and counted as fast-tracked, never a field item', () => {
    const rows = [
      // Submitted long ago (would breach the FIELD SLA if aged from submission) but fast-tracked 2h ago.
      { status: 'PENDING_GIFSY', submittedAt: new Date(ist(2026, 11, 2, 9, 0)), statusHistory: [FT_ROW] },
      // A normal Gifsy row.
      {
        status: 'PENDING_GIFSY',
        submittedAt: new Date(ist(2026, 11, 2, 9, 0)),
        statusHistory: [{ fromStatus: 'PENDING_RSM_APPROVAL', toStatus: 'PENDING_GIFSY', createdAt: new Date(now - HOUR) }],
      },
    ];
    const r = kycPendingBuckets(rows, targets, new Set(), now);
    expect(r.gifsy).toEqual({ pending: 2, within: 2, nearing: 0, breached: 0 });
    expect(r.field).toEqual({ pending: 0, within: 0, nearing: 0, breached: 0 });
    expect(r.gifsyFastTracked).toBe(1);
    expect(r.fieldFastTrackedExcluded).toBe(0);
  });

  it('fast-track: an UNMARKED DRAFT→PENDING_GIFSY edge is not fast-track (marker only, same as the dashboard)', () => {
    const rows = [
      {
        status: 'PENDING_GIFSY',
        submittedAt: new Date(now - 3 * HOUR),
        statusHistory: [{ fromStatus: 'DRAFT', toStatus: 'PENDING_GIFSY', metadata: null, createdAt: new Date(now - HOUR) }],
      },
    ];
    expect(kycPendingBuckets(rows, targets, new Set(), now).gifsyFastTracked).toBe(0);
  });

  it('fast-track: a fast-tracked KYC at a FIELD status is excluded from the field SLA and counted (never silently)', () => {
    const rows = [
      { status: 'PENDING_ASM_APPROVAL', submittedAt: new Date(ist(2026, 11, 2, 9, 0)), statusHistory: [FT_ROW] },
      { status: 'PENDING_ASM_APPROVAL', submittedAt: new Date(ist(2026, 11, 2, 9, 0)) },
    ];
    const r = kycPendingBuckets(rows, targets, new Set(), now);
    expect(r.field).toEqual({ pending: 1, within: 0, nearing: 0, breached: 1 });
    expect(r.fieldFastTrackedExcluded).toBe(1);
  });
});

describe('needsAttention', () => {
  it('a quiet tenant has nothing', () => {
    expect(needsAttention(quietTenant('deoleo', 'Deoleo'))).toEqual([]);
  });

  it('aggregates every abnormal item of a busy tenant', () => {
    expect(needsAttention(busyTenant())).toEqual([
      '2 KYCs breaching the Gifsy SLA',
      '12 KYCs breaching the field SLA',
      '5 negative wallets',
      '3 redemptions failed in the window, 2 via Hubble',
      'Hubble: 1 voucher stuck in processing > 30 min',
      '3 payouts failed or returned in the window (still open: 4 credit payouts (₹8,000) awaiting re-bank or reversal)',
      '8 messages failed delivery',
      'Targets changed — recalculate November 2026',
    ]);
  });

  it('Hubble failures are NOT listed twice: they ride the redemption bullet; alone only if Redemptions failed to load', () => {
    const t = quietTenant('x', 'X');
    t.redemptions = ok({ requested: 2, completed: 0, failed: 2, failedNotRefunded: 0, failedRows: [] });
    t.vouchers = ok({ issued: 0, failed: 2, stuckProcessing: 0, needsReconcile: 0 });
    expect(needsAttention(t)).toEqual(['2 redemptions failed in the window, 2 via Hubble']);
    t.redemptions = { ok: false, error: 'boom' };
    expect(needsAttention(t)).toEqual(["Couldn't load the Redemptions section", 'Hubble: 2 vouchers failed']);
  });

  it('D4: a window figure and its still-open figure are ONE bullet; events = the larger of the two (no double count)', () => {
    const t = quietTenant('x', 'X');
    t.redemptions = ok({ requested: 1, completed: 0, failed: 1, failedNotRefunded: 1, failedRows: [] });
    if (t.payouts.ok) Object.assign(t.payouts.data, { failedOrReturned: 1, openFailedCredit: 1, openFailedCreditPaise: 50000n });
    t.salesImport = ok({ processed: 0, failed: 2, failedOpen: 1, openMonths: [] });
    expect(attentionItems(t)).toEqual([
      { text: '1 redemption failed in the window (1 still holding points, not refunded)', events: 1 },
      { text: '1 payout failed or returned in the window (still open: 1 credit payout (₹500) awaiting re-bank or reversal)', events: 1 },
      { text: 'Sales Import: 2 imports failed in the window (1 still not replaced by a successful upload)', events: 2 },
    ]);
    const r = buildDailyOpsDigest(input([t]));
    expect(r.attentionItems).toBe(4);
    expect(r.subject).toContain('— 4 items need attention (1 tenant)');
  });

  it('D4: attention counts EVENTS (12 breaching KYCs = 12), not bullets', () => {
    const t = quietTenant('x', 'X');
    if (t.kyc.ok) t.kyc.data.field = { pending: 12, within: 0, nearing: 0, breached: 12 };
    expect(buildDailyOpsDigest(input([t])).attentionItems).toBe(12);
  });

  it('standing "still open" items count even with no window activity', () => {
    const t = quietTenant('x', 'X');
    t.redemptions = ok({ requested: 0, completed: 0, failed: 0, failedNotRefunded: 1, failedRows: [] });
    if (t.payouts.ok) t.payouts.data.openFailedRedemption = 2;
    t.salesImport = ok({ processed: 0, failed: 0, failedOpen: 1, openMonths: [] });
    expect(needsAttention(t)).toEqual([
      "Still open: 1 failed redemption still holds the outlet's points (not refunded)",
      'Still open: 2 redemption payouts failed without a refund',
      'Still open: 1 failed Sales Import not yet replaced by a successful upload',
    ]);
  });

  it('a failed section is itself an attention item', () => {
    const t = quietTenant('deoleo', 'Deoleo');
    t.points = { ok: false, error: 'timeout' };
    expect(needsAttention(t)).toEqual(["Couldn't load the Points section"]);
  });

  it('sales-import failures and Hubble reconcile flags count', () => {
    const t = quietTenant('x', 'X');
    t.vouchers = ok({ issued: 0, failed: 0, stuckProcessing: 0, needsReconcile: 2 });
    t.salesImport = ok({ processed: 0, failed: 1, failedOpen: 0, openMonths: [] });
    expect(needsAttention(t)).toEqual(['Hubble: 2 orders need reconcile', 'Sales Import: 1 import failed in the window']);
  });

  it('a fast-tracked KYC at a field stage and a failed Billing progress section are attention items', () => {
    const t = quietTenant('x', 'X');
    if (t.kyc.ok) t.kyc.data.fieldFastTrackedExcluded = 1;
    t.billing = { ok: false, error: 'timeout' };
    expect(needsAttention(t)).toEqual([
      '1 fast-tracked KYC at a field stage — not on the field SLA, check by hand',
      "Couldn't load the Billing progress section",
    ]);
  });
});

describe('gifsyWideAttention (voucher dispersal)', () => {
  it('nothing when absent or clean', () => {
    expect(gifsyWideAttention({})).toEqual([]);
    expect(
      gifsyWideAttention({
        voucherDispersal: ok({ bought: 9, buyFailed: 0, messageFailed: 0, pending: 3, pendingRetryable: 0, buyFailedOpen: 0, messageFailedOpen: 0 }),
      }),
    ).toEqual([]);
  });

  it('failed purchases, failed WhatsApps and pending > 2 h are called out', () => {
    expect(gifsyWideAttention({ voucherDispersal: busyDispersal() })).toEqual([
      'Voucher dispersal: 2 purchases failed in the window (3 still open)',
      'Voucher dispersal: 4 WhatsApp messages failed in the window (4 still open)',
      'Voucher dispersal: 1 purchase unconfirmed by Hubble for over 2 h (Retry available)',
    ]);
  });

  it('standing dispersal failures count even with nothing new in the window', () => {
    const d = ok({ bought: 0, buyFailed: 0, messageFailed: 0, pending: 0, pendingRetryable: 0, buyFailedOpen: 2, messageFailedOpen: 0 });
    expect(gifsyWideItems({ voucherDispersal: d })).toEqual([
      { text: 'Still open: Voucher dispersal: 2 purchases still failed (not retried)', events: 2 },
    ]);
  });

  it('Gifsy-wide OTP failures: pre-login + Gifsy staff, or the load failure; run notices first', () => {
    expect(gifsyWideAttention({ gifsyOtpFailed: ok({ preLogin: 4, gifsyStaff: 1 }) })).toEqual([
      '4 OTPs failed delivery before login (no tenant known)',
      '1 OTP to Gifsy staff failed delivery',
    ]);
    expect(gifsyWideAttention({ gifsyOtpFailed: { ok: false, error: 'x' }, runNotices: ['N1'] })).toEqual([
      'N1',
      "Couldn't load the Gifsy-wide OTP failures (x)",
    ]);
  });

  it('over-budget campaigns, failing status updates and late completions are each a line (never silent)', () => {
    const d = ok({
      bought: 0, buyFailed: 0, messageFailed: 0, pending: 0, pendingRetryable: 0, buyFailedOpen: 0, messageFailedOpen: 0,
      overBudgetCampaigns: 1, settleErrorCampaigns: 2, lateCompleted: 3,
    });
    expect(gifsyWideAttention({ voucherDispersal: d })).toEqual([
      "Voucher dispersal: 1 campaign over budget — spending is over the budget; see the campaign's budget breakdown",
      'Voucher dispersal: 2 campaigns whose status update keeps failing (contact Gifsy tech)',
      'Voucher dispersal: 3 purchases bought later by Hubble after they had failed / been refused (in the window)',
    ]);
    const html = buildDailyOpsDigest(input([quietTenant('d', 'D')], { voucherDispersal: d })).html;
    expect(html).toContain('data-section="Voucher dispersal (Gifsy-wide)"');
    expect(html).toContain('over budget');
  });

  it('Hubble activity on earlier (retired) orders in the window is a line — not counted as spend', () => {
    const d = ok({
      bought: 0, buyFailed: 0, messageFailed: 0, pending: 0, pendingRetryable: 0, buyFailedOpen: 0, messageFailedOpen: 0, earlierOrderAlerts: 2,
    });
    expect(gifsyWideAttention({ voucherDispersal: d })).toEqual([
      'Voucher dispersal: Hubble reported activity on 2 earlier orders after a retry or a "not bought" mark (in the window) — check with Hubble (a voucher may have been issued twice, or a paid voucher may not have reached the person)',
    ]);
  });

  it('unrecognised Hubble statuses are their own line; the earlier-order figure sits in the window line; closed rows are informational', () => {
    const d = ok({
      bought: 0, buyFailed: 0, messageFailed: 0, pending: 1, pendingRetryable: 0, buyFailedOpen: 0, messageFailedOpen: 0,
      unrecognisedStatus: 1, earlierOrderAlerts: 1, markedClosed: 2,
    });
    expect(gifsyWideAttention({ voucherDispersal: d })).toEqual([
      'Voucher dispersal: Hubble reported activity on 1 earlier order after a retry or a "not bought" mark (in the window) — check with Hubble (a voucher may have been issued twice, or a paid voucher may not have reached the person)',
      'Voucher dispersal: 1 purchase with a Hubble status we do not recognise — needs Gifsy tech',
    ]);
    const html = buildDailyOpsDigest(input([quietTenant('d', 'D')], { voucherDispersal: d })).html;
    const inWindow = html.slice(html.indexOf('In window'), html.indexOf('Right now'));
    expect(inWindow).toContain('earlier order reported by Hubble');
    expect(html.slice(html.indexOf('Right now'))).toContain('closed (marked not bought)');
    expect(html.slice(html.indexOf('Right now'))).toContain('Hubble status not recognised');
  });

  it('a load failure is itself an item', () => {
    expect(gifsyWideAttention({ voucherDispersal: { ok: false, error: 'boom' } })).toEqual([
      "Couldn't load the Voucher dispersal section",
    ]);
  });
});

describe('buildDailyOpsDigest', () => {
  it('subject: [Gifsy] prefix, the date and EVERY attention item (tenants + Gifsy-wide)', () => {
    const r = buildDailyOpsDigest(input([busyTenant(), quietTenant('deoleo', 'Deoleo')]));
    // events: 2 + 12 + 5 + 3 + 1 + max(3, 4) + 8 + 1
    expect(r.subject).toBe('[Gifsy] Daily operations — 13 Nov 2026 — 36 items need attention (1 tenant)');
    expect(r.key).toBe('dailyDigest');
    expect(r.tenantsNeedingAttention).toBe(1);
    expect(r.attentionItems).toBe(36);
  });

  it('all quiet → still a full email that says so', () => {
    const r = buildDailyOpsDigest(input([quietTenant('deoleo', 'Deoleo')]));
    expect(r.subject).toBe('[Gifsy] Daily operations — 13 Nov 2026 — all quiet');
    expect(r.html).toContain('All quiet — nothing needs attention.');
    expect(r.html).toContain('All quiet — nothing to report.');
  });

  it('subject never says "all quiet"/0 while a red OTP problem is in the body', () => {
    const r = buildDailyOpsDigest(input([quietTenant('d', 'D')], { gifsyOtpFailed: ok({ preLogin: 2, gifsyStaff: 0 }) }));
    expect(r.subject).toBe('[Gifsy] Daily operations — 13 Nov 2026 — 2 items need attention (Gifsy-wide)');
    expect(r.attentionItems).toBe(2);
    const failed = buildDailyOpsDigest(input([quietTenant('d', 'D')], { gifsyOtpFailed: { ok: false, error: 'boom' } }));
    expect(failed.subject).toBe('[Gifsy] Daily operations — 13 Nov 2026 — INCOMPLETE — 1 item needs attention (Gifsy-wide)');
    expect(failed.html).not.toContain('All quiet — nothing needs attention.');
  });

  it('run notices: red "incomplete" box at the top, attention items, INCOMPLETE in the subject', () => {
    const r = buildDailyOpsDigest(
      input([quietTenant('d', 'D')], {
        runNotices: ["Couldn't load the tenant list (x)"],
        sharedFailures: [{ key: 'shared/tenants', label: 'tenant list' }],
      }),
    );
    expect(r.subject).toBe('[Gifsy] Daily operations — 13 Nov 2026 — INCOMPLETE — 1 item needs attention (Gifsy-wide)');
    expect(r.html).toContain('data-run-notices="1"');
    expect(r.html).toContain('This digest is incomplete');
    expect(r.html.indexOf('This digest is incomplete')).toBeLessThan(r.html.indexOf('All tenants'));
  });

  it('D2: any failed section makes the digest INCOMPLETE (subject + red box) and is listed by failedSections', () => {
    const t = quietTenant('bajaj', 'Bajaj');
    t.points = { ok: false, error: 'not loaded (time budget)' };
    const inp = input([t], { voucherDispersal: { ok: false, error: 'x' } });
    expect(failedSections(inp)).toEqual([
      { key: 'bajaj/points', label: 'Bajaj: Points' },
      { key: 'gifsy/voucher-dispersal', label: 'Voucher dispersal' },
    ]);
    const r = buildDailyOpsDigest(inp);
    expect(r.subject).toContain('INCOMPLETE — ');
    expect(r.html).toContain('Not loaded: Bajaj: Points; Voucher dispersal — those figures are missing below and will be repeated in the next digest.');
    expect(r.failedSections).toHaveLength(2);
  });

  it('D2c: a section failing 3 runs in a row → "INCOMPLETE 3 days" in the subject and a red line', () => {
    const t = quietTenant('bajaj', 'Bajaj');
    t.points = { ok: false, error: 'x' };
    const r = buildDailyOpsDigest(input([t], { incompleteStreak: { runs: 3, sections: ['Bajaj: Points'] } }));
    expect(r.subject).toBe('[Gifsy] Daily operations — 13 Nov 2026 — INCOMPLETE 3 days — 1 item needs attention (1 tenant)');
    expect(r.html).toContain('Bajaj: Points failed to load 3 runs in a row.');
    const two = buildDailyOpsDigest(input([t], { incompleteStreak: { runs: 2, sections: ['Bajaj: Points'] } }));
    expect(two.subject).toContain('— INCOMPLETE — ');
  });

  it('D2a: the repeat notice is shown plainly at the top (not an attention item)', () => {
    const r = buildDailyOpsDigest(
      input([quietTenant('d', 'D')], {
        repeatNotice: "This email repeats X because the 12 Nov 2026 digest was incomplete (Bajaj: Points). Don't add these figures to that day's.",
      }),
    );
    expect(r.html).toContain('data-repeat-notice="1"');
    expect(r.html.indexOf('data-repeat-notice')).toBeLessThan(r.html.indexOf('All tenants'));
    expect(r.attentionItems).toBe(0);
  });

  it('non-ACTIVE tenants: shown (marked) with activity / open items, otherwise NAMED as not shown', () => {
    const busyOnboarding = { ...quietTenant('o', 'Onb Co'), status: 'ONBOARDING' as const };
    busyOnboarding.points = ok({ credited: 10, redeemed: 0, expired: 0, negativeWallets: 0 });
    const quietInactive = { ...quietTenant('i', 'Old Co'), status: 'INACTIVE' as const };
    // Billing progress alone (always rendered for Sales-Import tenants) is not "activity".
    quietInactive.billing = ok({ month: '2026-11', kpiLabel: null, asOf: null, withTarget: 0, notStarted: 0, noTarget: 0, notCovered: 0, targetsOutsideRoster: 0 });
    const r = buildDailyOpsDigest(input([quietTenant('a', 'Active Co'), busyOnboarding, quietInactive]));
    expect(r.html).toContain('data-tenant="o"');
    expect(r.html).toContain('>ONBOARDING<');
    expect(r.html).toContain('Onb Co (ONBOARDING)');
    expect(r.html).not.toContain('data-tenant="i"');
    expect(r.html).toContain('Not shown (not ACTIVE, no activity and no open items): Old Co (INACTIVE).');
    expect(r.hiddenTenants).toBe(1);
    expect(r.html).toContain('data-tenant="a"'); // ACTIVE tenants always shown
  });

  it('dropped (non-internal) recipients are named in the footer', () => {
    const r = buildDailyOpsDigest(input([quietTenant('d', 'D')], { droppedRecipients: ['cfo@acme.com'] }));
    expect(r.html).toContain('Not sent to cfo@acme.com — not an internal address');
  });

  it('window notes ride the intro line', () => {
    const r = buildDailyOpsDigest(input([quietTenant('d', 'D')], { windowNotes: ['(manual re-run)'] }));
    expect(r.html).toContain('Window: Thu 12 Nov, 09:30 → Fri 13 Nov, 09:30 IST — (manual re-run)');
  });

  it('vouchers show live problems for a tenant with Hubble switched off, labelled so', () => {
    const t = { ...quietTenant('x', 'X'), hubbleEnabled: false };
    t.vouchers = ok({ issued: 0, failed: 0, stuckProcessing: 1, needsReconcile: 0 });
    const html = buildDailyOpsDigest(input([t])).html;
    expect(html).toContain('data-section="Vouchers (Hubble) — integration switched off"');
    expect(needsAttention(t)).toEqual(['Hubble: 1 voucher stuck in processing > 30 min']);
  });

  it('payouts: the batches line shows outlets (old Credits email figure) and a still-open line', () => {
    const html = buildDailyOpsDigest(input([busyTenant()])).html;
    expect(html).toContain('outlets <strong style="color:#111827;">412</strong>');
    expect(html).toContain('credit failed (re-bank / reverse)');
  });

  it('a quiet tenant renders as just its name + one line (every section hidden)', () => {
    const html = buildDailyOpsDigest(input([quietTenant('deoleo', 'Deoleo')])).html;
    const block = html.slice(html.indexOf('data-tenant="deoleo"'));
    expect(block).not.toContain('data-section=');
    expect(block).not.toContain('Needs attention');
    expect(block).toContain('All quiet — nothing to report.');
  });

  it('hides an empty section but shows a non-empty one', () => {
    const t = quietTenant('deoleo', 'Deoleo');
    t.points = ok({ credited: 500, redeemed: 0, expired: 0, negativeWallets: 0 });
    const html = buildDailyOpsDigest(input([t])).html;
    expect(html).toContain('data-section="Points"');
    expect(html).not.toContain('data-section="Redemptions"');
    expect(html).not.toContain('All quiet — nothing to report.');
  });

  it('orders tenants by needs-attention desc, then name', () => {
    const a = quietTenant('a', 'Alpha');
    const z = quietTenant('z', 'Zulu');
    z.redemptions = ok({ requested: 1, completed: 0, failed: 1, failedNotRefunded: 0, failedRows: [] });
    const m = quietTenant('m', 'Mike');
    const html = buildDailyOpsDigest(input([a, m, z])).html;
    const pos = (id: string) => html.indexOf(`data-tenant="${id}"`);
    expect(pos('z')).toBeLessThan(pos('a'));
    expect(pos('a')).toBeLessThan(pos('m'));
    // The summary table follows the same order.
    expect(html.indexOf('>Zulu<')).toBeLessThan(html.indexOf('>Alpha<'));
  });

  it('escapes every dynamic value', () => {
    const t = busyTenant();
    t.name = '<script>alert(1)</script>';
    const r = buildDailyOpsDigest(input([t]));
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.html).toContain('Patel &amp; Sons &lt;Wholesale&gt;');
  });

  it('a failed section renders "couldn\'t load this section" (escaped reason) and the rest still renders', () => {
    const t = busyTenant();
    t.messages = { ok: false, error: 'relation "x" <does not exist>' };
    const html = buildDailyOpsDigest(input([t])).html;
    expect(html).toContain("Couldn't load this section (relation &quot;x&quot; &lt;does not exist&gt;).");
    expect(html).toContain("Couldn&#39;t load the Messages section");
    expect(html).toContain('data-section="KYC"');
    expect(html).toContain('data-section="Payouts"');
  });

  it('hides empty Hubble / Visibility / Sales Import, shows them when present', () => {
    const quiet = buildDailyOpsDigest(input([quietTenant('deoleo', 'Deoleo')])).html;
    expect(quiet).not.toContain('Vouchers (Hubble)');
    expect(quiet).not.toContain('data-section="Visibility"');
    expect(quiet).not.toContain('data-section="Sales Import"');
    const busy = buildDailyOpsDigest(input([busyTenant()])).html;
    expect(busy).toContain('Vouchers (Hubble)');
    expect(busy).toContain('data-section="Visibility"');
    expect(busy).toContain('data-section="Sales Import"');
    expect(busy).toContain('Yes — recalculate');
  });

  it('lists failed redemptions and caps the rows at 10', () => {
    const t = quietTenant('x', 'X');
    const rows = Array.from({ length: 14 }, (_, i) => ({ outlet: `Outlet ${i}`, reward: 'R', reason: 'why' }));
    t.redemptions = ok({ requested: 14, completed: 0, failed: 14, failedNotRefunded: 0, failedRows: rows });
    const html = buildDailyOpsDigest(input([t])).html;
    expect(html).toContain('Outlet 9<');
    expect(html).not.toContain('Outlet 10<');
    expect(html).toContain('Showing the latest 10 of 14.');
  });

  it('surfaces Gifsy-wide OTP failures (or their load failure) in the Gifsy-wide box', () => {
    const r1 = buildDailyOpsDigest(input([quietTenant('d', 'D')], { gifsyOtpFailed: ok({ preLogin: 4, gifsyStaff: 2 }) }));
    expect(r1.html).toContain('4 OTPs failed delivery before login');
    expect(r1.html).toContain('2 OTPs to Gifsy staff failed delivery');
    expect(r1.html).toContain('Needs attention — Gifsy-wide');
    expect(r1.html).not.toContain('All quiet — nothing needs attention.');
    const r2 = buildDailyOpsDigest(input([quietTenant('d', 'D')], { gifsyOtpFailed: { ok: false, error: 'boom' } }));
    expect(r2.html).toContain('Couldn&#39;t load the Gifsy-wide OTP failures (boom)');
  });

  it('voucher dispersal: hidden when all zero; shown + Gifsy-wide box + subject suffix when there are problems', () => {
    const zero = buildDailyOpsDigest(input([quietTenant('d', 'D')], { voucherDispersal: zeroDispersal() }));
    expect(zero.html).not.toContain('Voucher dispersal');
    expect(zero.subject).toBe('[Gifsy] Daily operations — 13 Nov 2026 — all quiet');
    expect(zero.html).toContain('All quiet — nothing needs attention.');

    const busy = buildDailyOpsDigest(input([quietTenant('d', 'D')], { voucherDispersal: busyDispersal() }));
    // events: max(2, 3) + max(4, 4) + 1
    expect(busy.subject).toBe('[Gifsy] Daily operations — 13 Nov 2026 — 8 items need attention (Gifsy-wide)');
    expect(busy.gifsyWideItems).toBe(3);
    expect(busy.attentionItems).toBe(8);
    expect(busy.html).toContain('Needs attention — Gifsy-wide');
    expect(busy.html).toContain('data-section="Voucher dispersal (Gifsy-wide)"');
    expect(busy.html).not.toContain('All quiet — nothing needs attention.');

    const failed = buildDailyOpsDigest(input([quietTenant('d', 'D')], { voucherDispersal: { ok: false, error: 'no table' } }));
    expect(failed.html).toContain("Couldn't load this section (no table).");
    expect(failed.html).not.toContain('All quiet — nothing needs attention.');
  });

  it('KYC: fast-tracked count rides the Gifsy line; a field-stage fast-track gets a red note', () => {
    const html = buildDailyOpsDigest(input([busyTenant()])).html;
    expect(html).toContain('of which fast-tracked (skipped field)');
    const t = quietTenant('x', 'X');
    if (t.kyc.ok) t.kyc.data.fieldFastTrackedExcluded = 2;
    const h2 = buildDailyOpsDigest(input([t])).html;
    expect(h2).toContain('2 fast-tracked KYCs are at a field stage — left out of the field SLA');
  });

  it('billing progress: "N of M", data date, not-counted notes, and the honest empty / no-KPI states', () => {
    const busy = buildDailyOpsDigest(input([busyTenant()])).html;
    expect(busy).toContain('data-section="Billing progress"');
    expect(busy).toContain('1,840 of 6,417 with a target');
    expect(busy).toContain('KPI Total Sales · data up to 12 Nov 2026');
    expect(busy).toContain('Not counted above: 35 outlets have no target; 2 targets are for outlets not in the live roster.');

    const base = { month: '2026-11', asOf: null, withTarget: 0, notStarted: 0, noTarget: 0, notCovered: 0, targetsOutsideRoster: 0 };
    const t1 = quietTenant('a', 'A');
    t1.billing = ok({ ...base, kpiLabel: null });
    expect(buildDailyOpsDigest(input([t1])).html).toContain("No enabled KPI for this tenant — billing progress for November 2026 can&#39;t be shown.");
    const t2 = quietTenant('b', 'B');
    t2.billing = ok({ ...base, kpiLabel: 'Total Sales' });
    const h2 = buildDailyOpsDigest(input([t2])).html;
    expect(h2).toContain('No outlet has a Total Sales target for November 2026 — nothing to measure.');
    expect(h2).toContain('no sales uploaded for November 2026 yet');
  });

  /**
   * The committed owner-facing sample (platform/docs/plans/samples/daily-ops-digest-sample.html) is a
   * golden file of this fixture. Regenerate after an intentional layout change with:
   *   UPDATE_DIGEST_SAMPLE=1 npx jest src/reports/scheduled/daily-ops-digest-report.spec.ts
   */
  it('matches the committed sample HTML (busy Bajaj-like + quiet Deoleo-like tenant)', () => {
    const quietDeoleo = quietTenant('deoleo', 'Deoleo India');
    const html = buildDailyOpsDigest(
      input([quietDeoleo, busyTenant()], { gifsyOtpFailed: ok({ preLogin: 0, gifsyStaff: 0 }), voucherDispersal: busyDispersal() }),
    ).html;
    const file = path.resolve(__dirname, '../../../../platform/docs/plans/samples/daily-ops-digest-sample.html');
    if (process.env.UPDATE_DIGEST_SAMPLE === '1') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html, 'utf8');
    }
    expect(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(html.replace(/\r\n/g, '\n'));
  });
});
