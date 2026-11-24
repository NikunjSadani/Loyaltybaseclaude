/**
 * Daily Operations Digest — the ONE internal Gifsy email (owner-approved 2026-11-13; replaces the
 * separate Credits/Payouts summary + KYC actionables digest). An all-tenant summary on top, then one
 * section per tenant. Design: platform/docs/plans/DAILY-OPS-DIGEST.md.
 *
 * PURE: no DB, no clock. The runner (scheduled-reports.service.ts) does all the Prisma and passes
 * plain structs (report.types.ts). Every dynamic value is HTML-escaped (`esc`). Also exports the
 * other pure pieces the runner needs: the reporting window label (`windowBetween`, and `digestWindow` —
 * the first-run fallback) and the KYC pending-SLA roll-up (`kycPendingBuckets`, which reuses the admin KYC
 * dashboard's own rule `kycPendingAge`).
 */

import type { KycSlaTargets } from '../../common/kyc-sla-stage';
import { kycPendingAge } from '../../admin-core/dashboards/kyc-pending-sla';
import { formatDateIST } from '../../common/ist-date';
import { isFastTrackRow, type KycFastTrackHistoryRow } from '../../kyc/kyc-fast-track.helper';
import { monthLabel } from '../../sales-import/months/month-state';
import { emailShell, esc, intIN, rupees, sectionHeading, statRow, table } from './email-html';
import { VISIBILITY_WORDS } from '../../visibility/visibility-report-labels';
import { BACKFILL_NEXT_STEP } from '../../wallet/reversal-policy';

/** Mirrors digest-run-state PERSISTENT_FAILURE_RUNS (kept here so this module stays import-cycle free). */
const PERSISTENT_FAILURE_RUNS = 3;
import type {
  BillingSection,
  DigestInput,
  FundSection,
  HeldBalancesSection,
  DigestResult,
  DigestWindow,
  KycSection,
  SectionResult,
  SlaBucket,
  TenantDigest,
  VoucherDispersalSection,
} from './report.types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const IST_OFFSET_MS = 330 * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A KYC row nearing breach: at or above this share of its stage target (but not over it). */
export const KYC_NEARING_RATIO = 0.75;
/** At most this many failed redemptions are listed per tenant. */
export const MAX_FAILED_REDEMPTION_ROWS = 10;

// ── Window ────────────────────────────────────────────────────────────────────────────────────

/** "Sat 08 Nov, 09:30" — the IST wall-clock of an instant. */
function istStamp(ms: number): string {
  const s = new Date(ms + IST_OFFSET_MS);
  const hh = String(s.getUTCHours()).padStart(2, '0');
  const mm = String(s.getUTCMinutes()).padStart(2, '0');
  const date = formatDateIST(new Date(ms)).slice(0, 6); // "08 Nov"
  return `${WEEKDAYS[s.getUTCDay()]} ${date}, ${hh}:${mm}`;
}

/** A window [startMs, endMs) with its IST label. */
export function windowBetween(startMs: number, endMs: number): DigestWindow {
  return { startMs, endMs, label: `${istStamp(startMs)} → ${istStamp(endMs)} IST` };
}

/**
 * The FIRST-RUN fallback window, ending at `nowMs`: since the same time on the previous WORKING day.
 * The digest runs Mon–Sat, so on a Monday (IST) the window reaches back to Saturday at the same time
 * (48 h, covering Sunday); any other day it is the last 24 h. Once a successful send is recorded the
 * window runs from that send's end instead (digest-run-state.ts `planDigestWindow`).
 */
export function digestWindow(nowMs: number): DigestWindow {
  const istWeekday = new Date(nowMs + IST_OFFSET_MS).getUTCDay();
  const span = istWeekday === 1 ? 2 * DAY_MS : DAY_MS;
  return windowBetween(nowMs - span, nowMs);
}

// ── KYC pending roll-up (reuses the shared two-stage business-hours SLA) ─────────────────────

export interface KycPendingRow {
  status: string;
  submittedAt: Date | string | number | null;
  createdAt?: Date | string | number | null;
  /**
   * The submission's PENDING_GIFSY history entries (for the latest Gifsy entry). fromStatus + metadata let the
   * fast-track routing row (DRAFT→PENDING_GIFSY + marker) be recognised with the shared `isFastTrackRow`.
   */
  statusHistory?: Array<KycFastTrackHistoryRow & { createdAt?: Date | string | number | null }> | null;
}

const emptyBucket = (): SlaBucket => ({ pending: 0, within: 0, nearing: 0, breached: 0 });

export interface KycPendingRollup {
  field: SlaBucket;
  gifsy: SlaBucket;
  /** Of gifsy.pending: fast-tracked (no field stage). */
  gifsyFastTracked: number;
  /** Fast-tracked rows at a field status — excluded from the field SLA, reported instead. */
  fieldFastTrackedExcluded: number;
}

/**
 * Bucket one tenant's pending KYC rows by stage (field / Gifsy) and SLA state with the admin KYC
 * dashboard's OWN rule (`kycPendingAge`, dashboards/kyc-pending-sla.ts): field rows age from
 * submission, Gifsy rows from the LATEST PENDING_GIFSY entry, in business hours (weekends + the
 * holiday set excluded), UNROUNDED — breached when age > target, exactly the dashboard's test (no
 * rounding before the comparison). Nearing = 75 % of target ≤ age ≤ target. The runner feeds it the
 * dashboard's population (latest submission per addressable outlet), so the counts match the card.
 *
 * GIFSY-reject fast-track: a fast-tracked KYC skipped the field chain, so it is NEVER a field-SLA item — the same
 * rule as the admin dashboard's field-chain exclusion (`isFastTrackRow` on the history; proven only by the marker,
 * never by the bare DRAFT→PENDING_GIFSY edge). At Gifsy it ages on the Gifsy clock as normal and is counted in
 * `gifsyFastTracked`; at a field status (no such path today) it is excluded from the field bucket and counted in
 * `fieldFastTrackedExcluded` so it is shown, never silently dropped.
 */
export function kycPendingBuckets(
  rows: KycPendingRow[],
  targets: KycSlaTargets,
  holidays: Set<string>,
  nowMs: number,
): KycPendingRollup {
  const field = emptyBucket();
  const gifsy = emptyBucket();
  let gifsyFastTracked = 0;
  let fieldFastTrackedExcluded = 0;
  for (const r of rows) {
    if (!r || typeof r.status !== 'string') continue;
    const live = kycPendingAge(
      { status: r.status, submittedAt: r.submittedAt, createdAt: r.createdAt, statusHistory: r.statusHistory as never },
      nowMs,
      holidays,
    );
    if (!live) continue;
    const fastTracked = Array.isArray(r.statusHistory) && r.statusHistory.some((h) => isFastTrackRow(h));
    if (fastTracked && live.stage === 'field') {
      fieldFastTrackedExcluded += 1;
      continue;
    }
    if (fastTracked) gifsyFastTracked += 1;
    const target = live.stage === 'gifsy' ? targets.gifsyHrs : targets.fieldHrs;
    const b = live.stage === 'gifsy' ? gifsy : field;
    b.pending += 1;
    if (live.ageHrs > target) b.breached += 1;
    else if (live.ageHrs >= target * KYC_NEARING_RATIO) b.nearing += 1;
    else b.within += 1;
  }
  return { field, gifsy, gifsyFastTracked, fieldFastTrackedExcluded };
}

// ── Needs attention ───────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${intIN(n)} ${n === 1 ? one : many}`;

/**
 * One "needs attention" bullet and how many EVENTS it stands for (the subject / total count events, not
 * bullets). A bullet that merges a window figure with the matching "still open now" figure counts the
 * larger of the two: the two overlap (a failure in the window that is still open is in both) and the
 * digest does not read which rows they share, so max() is the honest lower bound of distinct events.
 */
export interface AttentionItem {
  text: string;
  events: number;
}

/** "N in the window (M still open)" merged wording for a window figure + its standing figure. */
function windowAndOpen(windowN: number, openN: number, windowText: (n: number) => string, openText: (n: number) => string): AttentionItem | null {
  if (windowN === 0 && openN === 0) return null;
  if (windowN === 0) return { text: `Still open: ${openText(openN)}`, events: openN };
  return { text: `${windowText(windowN)} (${intIN(openN)} still open)`, events: Math.max(windowN, openN) };
}

/** Every abnormal item for one tenant, with its event count (escaped at render time). */
export function attentionItems(t: TenantDigest): AttentionItem[] {
  const out: AttentionItem[] = [];
  const push = (text: string, events: number) => out.push({ text, events });
  const failed = (label: string, r: SectionResult<unknown> | undefined) => {
    if (r && !r.ok) push(`Couldn't load the ${label} section`, 1);
  };

  failed('KYC', t.kyc);
  if (t.kyc.ok) {
    const { gifsy, field } = t.kyc.data;
    if (gifsy.breached > 0) push(`${plural(gifsy.breached, 'KYC', 'KYCs')} breaching the Gifsy SLA`, gifsy.breached);
    if (field.breached > 0) push(`${plural(field.breached, 'KYC', 'KYCs')} breaching the field SLA`, field.breached);
    const ftField = t.kyc.data.fieldFastTrackedExcluded;
    if (ftField > 0) {
      push(`${plural(ftField, 'fast-tracked KYC', 'fast-tracked KYCs')} at a field stage — not on the field SLA, check by hand`, ftField);
    }
  }

  failed('Points', t.points);
  if (t.points.ok && t.points.data.negativeWallets > 0) {
    const owed = t.points.data.owedPoints;
    push(
      plural(t.points.data.negativeWallets, 'negative wallet', 'negative wallets') +
        (owed ? ` (${intIN(owed)} pts owed)` : ''),
      t.points.data.negativeWallets,
    );
  }
  // Reversal readiness (never silent): wallets a points reversal would be refused on until Gifsy acts.
  const notSeq = t.points.ok ? t.points.data.walletsNotSequenced ?? 0 : 0;
  if (notSeq > 0) {
    push(
      `${plural(notSeq, 'wallet', 'wallets')} with points history not yet prepared for reversals — ${BACKFILL_NEXT_STEP}`,
      notSeq,
    );
  }
  const blockedW = t.points.ok ? t.points.data.walletsBlocked ?? 0 : 0;
  if (blockedW > 0) {
    push(`${plural(blockedW, 'wallet', 'wallets')} blocked by the wallet backfill — fix the history and re-run it`, blockedW);
  }

  // Redemption failures, Hubble voucher failures and "failed but not refunded" overlap: ONE bullet. The Hubble
  // bullet stands alone only when the Redemptions section itself could not be loaded.
  failed('Redemptions', t.redemptions);
  const hubbleFailed = t.vouchers?.ok ? t.vouchers.data.failed : 0;
  if (t.redemptions.ok) {
    const r = t.redemptions.data;
    const share = hubbleFailed > 0 ? `, ${intIN(Math.min(hubbleFailed, r.failed))} via Hubble` : '';
    const held = r.failedNotRefunded;
    if (r.failed > 0) {
      push(
        `${plural(r.failed, 'redemption', 'redemptions')} failed in the window${share}${held > 0 ? ` (${intIN(held)} still holding points, not refunded)` : ''}`,
        Math.max(r.failed, held),
      );
    } else if (held > 0) {
      push(`Still open: ${plural(held, 'failed redemption still holds', 'failed redemptions still hold')} the outlet's points (not refunded)`, held);
    }
  } else if (hubbleFailed > 0) {
    push(`Hubble: ${plural(hubbleFailed, 'voucher', 'vouchers')} failed`, hubbleFailed);
  }

  failed('Vouchers (Hubble)', t.vouchers);
  if (t.vouchers?.ok) {
    const v = t.vouchers.data;
    if (v.stuckProcessing > 0) push(`Hubble: ${plural(v.stuckProcessing, 'voucher', 'vouchers')} stuck in processing > 30 min`, v.stuckProcessing);
    if (v.needsReconcile > 0) push(`Hubble: ${plural(v.needsReconcile, 'order needs', 'orders need')} reconcile`, v.needsReconcile);
  }

  failed('Payouts', t.payouts);
  if (t.payouts.ok) {
    const p = t.payouts.data;
    const open = p.openFailedCredit + p.openFailedRedemption;
    const parts: string[] = [];
    if (p.openFailedCredit > 0) {
      parts.push(`${plural(p.openFailedCredit, 'credit payout', 'credit payouts')} (${rupees(p.openFailedCreditPaise)}) awaiting re-bank or reversal`);
    }
    if (p.openFailedRedemption > 0) {
      parts.push(`${plural(p.openFailedRedemption, 'redemption payout', 'redemption payouts')} failed without a refund`);
    }
    if (p.failedOrReturned > 0) {
      push(
        `${plural(p.failedOrReturned, 'payout', 'payouts')} failed or returned in the window${open > 0 ? ` (still open: ${parts.join('; ')})` : ''}`,
        Math.max(p.failedOrReturned, open),
      );
    } else if (open > 0) {
      push(`Still open: ${parts.join('; ')}`, open);
    }
  }

  failed('TDS (194R)', t.tds);
  if (t.tds?.ok && t.tds.data.excessRetailerCount > 0) {
    const x = t.tds.data;
    push(
      `TDS taken in excess for ${plural(x.excessRetailerCount, 'retailer', 'retailers')} (${rupees(x.totalExcessPaise)}) — flagged, no automatic refund`,
      x.excessRetailerCount,
    );
  }

  failed('Messages', t.messages);
  if (t.messages.ok) {
    const m = t.messages.data;
    const total = m.otpFailed + m.smsFailed + m.whatsappFailed + m.broadcastFailed;
    if (total > 0) push(`${plural(total, 'message', 'messages')} failed delivery`, total);
  }

  failed('Visibility', t.visibility);

  failed('Sales Import', t.salesImport);
  if (t.salesImport?.ok) {
    const s = t.salesImport.data;
    if (s.failed > 0) {
      push(
        `Sales Import: ${plural(s.failed, 'import', 'imports')} failed in the window${s.failedOpen > 0 ? ` (${intIN(s.failedOpen)} still not replaced by a successful upload)` : ''}`,
        Math.max(s.failed, s.failedOpen),
      );
    } else if (s.failedOpen > 0) {
      push(`Still open: ${plural(s.failedOpen, 'failed Sales Import', 'failed Sales Imports')} not yet replaced by a successful upload`, s.failedOpen);
    }
    for (const m of s.openMonths) {
      if (m.targetsChangedSinceApply) push(`Targets changed — recalculate ${monthLabel(m.month)}`, 1);
    }
  }

  failed('Billing progress', t.billing);

  failed('Held opening balances', t.heldBalances);
  if (t.heldBalances?.ok) {
    const h = t.heldBalances.data;
    if (h.failed > 0) {
      push(`${plural(h.failed, 'held opening balance', 'held opening balances')} FAILED (${intIN(h.failedPoints)} pts) — not posted; see Gifsy → Held Balances`, h.failed);
    }
    if (h.waitingNeedsApplyNow > 0) {
      push(
        `${plural(h.waitingNeedsApplyNow, 'held opening balance waits', 'held opening balances wait')} for a Gifsy "Apply now" (the outlet's wallet already has activity)`,
        h.waitingNeedsApplyNow,
      );
    }
    const amb = h.waitingByState?.AMBIGUOUS_OUTLET ?? 0;
    if (amb > 0) push(`${plural(amb, 'held opening balance', 'held opening balances')} blocked: the outlet code matches more than one outlet — fix the outlet codes`, amb);
  }

  failed('Fund', t.fund);
  if (t.fund?.ok) {
    const f = t.fund.data;
    if (f.isLow) {
      push(`Fund balance LOW: ${rupees(f.balancePaise)} (threshold ${rupees(f.thresholdPaise ?? 0n)}) — nothing is blocked`, 1);
    }
    const a = f.alert;
    if (a && (a.status === 'failed' || a.status === 'email-not-configured' || a.status === 'test-recipient-not-internal' || a.status === 'not-checked-time-budget')) {
      push(`Fund low-balance e-mail to the client NOT sent: ${a.error ?? a.status}`, 1);
    } else if (f.isLow && a?.status === 'no-recipients') {
      push('Fund low-balance e-mail not sent: no alert recipients configured', 1);
    } else if (a?.status === 'no-opening') {
      push('Fund: set the opening balance to start low-balance alerts', 1);
    } else if (f.isLow && a?.status === 'disabled-in-environment') {
      push('Fund low-balance e-mail not sent: client e-mails are switched off on this server (FUND_ALERTS_LIVE / FUND_ALERTS_TEST_RECIPIENT)', 1);
    }
    if (f.missingRates > 0) {
      push(`Fund: ${plural(f.missingRates, 'spend line', 'spend lines')} charged without a rate (voucher brand discount / agency fee not set)`, f.missingRates);
    }
  }
  return out;
}

/** The tenant's attention bullets (text only). */
export function needsAttention(t: TenantDigest): string[] {
  return attentionItems(t).map((a) => a.text);
}

/**
 * Gifsy-wide (not tenant) attention items: run notices (a shared input failed, the window was capped…),
 * Gifsy-wide OTP failures (pre-login + Gifsy staff, or their load failure) and Voucher Dispersal.
 */
export function gifsyWideItems(input: Pick<DigestInput, 'voucherDispersal' | 'gifsyOtpFailed' | 'runNotices' | 'authEvents'>): AttentionItem[] {
  const out: AttentionItem[] = (input.runNotices ?? []).map((text) => ({ text, events: 1 }));
  const otp = input.gifsyOtpFailed;
  if (otp && !otp.ok) out.push({ text: `Couldn't load the Gifsy-wide OTP failures (${otp.error})`, events: 1 });
  else if (otp && otp.ok) {
    if (otp.data.preLogin > 0) {
      out.push({ text: `${plural(otp.data.preLogin, 'OTP', 'OTPs')} failed delivery before login (no tenant known)`, events: otp.data.preLogin });
    }
    if (otp.data.gifsyStaff > 0) {
      out.push({ text: `${plural(otp.data.gifsyStaff, 'OTP', 'OTPs')} to Gifsy staff failed delivery`, events: otp.data.gifsyStaff });
    }
  }
  const auth = input.authEvents;
  if (auth && !auth.ok) out.push({ text: `Couldn't load the sign-in security events (${auth.error})`, events: 1 });
  else if (auth && auth.ok) {
    const a = auth.data;
    if (a.reuseKills > 0) {
      out.push({ text: `Sign-in security: ${plural(a.reuseKills, 'refresh-token reuse', 'refresh-token reuses')} detected — all sessions of the user revoked`, events: a.reuseKills });
    }
    if (a.repeatedHandbacks > 0) {
      out.push({ text: `Sign-in security: ${plural(a.repeatedHandbacks, 'user', 'users')} with repeated session handbacks in 24 h (possible shared stolen session — review)`, events: a.repeatedHandbacks });
    }
    if (a.firstUseMarkFailures > 0) {
      out.push({ text: `Sign-in security: ${plural(a.firstUseMarkFailures, 'session first-use mark', 'session first-use marks')} failed to save`, events: a.firstUseMarkFailures });
    }
    if ((a.handbackAuditFailures ?? 0) > 0) {
      const n = a.handbackAuditFailures ?? 0;
      out.push({ text: `Sign-in security: ${plural(n, 'session handback audit write', 'session handback audit writes')} failed`, events: n });
    }
    if ((a.deviceUnknownRefusals ?? 0) > 0) {
      const n = a.deviceUnknownRefusals ?? 0;
      out.push({ text: `Sign-in security: ${plural(n, 'returning device', 'returning devices')} had to sign in again because the device could not be identified`, events: n });
    }
    if (a.internalSecretConfigured === false) {
      out.push({ text: 'Sign-in security: INTERNAL_PROXY_SECRET is not configured on the API — device binding is OFF (lost-response devices must sign in again)', events: 1 });
    }
  }
  const vd = input.voucherDispersal;
  if (!vd) return out;
  if (!vd.ok) {
    out.push({ text: `Couldn't load the Voucher dispersal section`, events: 1 });
    return out;
  }
  const d = vd.data;
  // Window failures and the standing "still failed now" figures overlap — one bullet per topic.
  const buy = windowAndOpen(
    d.buyFailed,
    d.buyFailedOpen,
    (n) => `Voucher dispersal: ${plural(n, 'purchase', 'purchases')} failed in the window`,
    (n) => `Voucher dispersal: ${plural(n, 'purchase', 'purchases')} still failed (not retried)`,
  );
  if (buy) out.push(buy);
  const msg = windowAndOpen(
    d.messageFailed,
    d.messageFailedOpen,
    (n) => `Voucher dispersal: ${plural(n, 'WhatsApp message', 'WhatsApp messages')} failed in the window`,
    (n) => `Voucher dispersal: ${plural(n, 'WhatsApp message', 'WhatsApp messages')} still failed (not resent)`,
  );
  if (msg) out.push(msg);
  if (d.pendingRetryable > 0) {
    out.push({
      text: `Voucher dispersal: ${plural(d.pendingRetryable, 'purchase', 'purchases')} unconfirmed by Hubble for over 2 h (Retry available)`,
      events: d.pendingRetryable,
    });
  }
  // Owner rule — never silent: money over the budget, a status that cannot be updated, late completions.
  if ((d.overBudgetCampaigns ?? 0) > 0) {
    out.push({
      text: `Voucher dispersal: ${plural(d.overBudgetCampaigns!, 'campaign', 'campaigns')} over budget — spending is over the budget; see the campaign's budget breakdown`,
      events: d.overBudgetCampaigns!,
    });
  }
  if ((d.settleErrorCampaigns ?? 0) > 0) {
    out.push({
      text: `Voucher dispersal: ${plural(d.settleErrorCampaigns!, 'campaign', 'campaigns')} whose status update keeps failing (contact Gifsy tech)`,
      events: d.settleErrorCampaigns!,
    });
  }
  // Earlier-order alerts created or worsened in the window — worded per kind / status (review of 4d8454ad, M4).
  const by = d.earlierOrderAlertsBy;
  if (by) {
    if (by.superseded > 0) {
      out.push({
        text: `Voucher dispersal: Hubble reported activity on ${plural(by.superseded, 'earlier order', 'earlier orders')} retired by a retry (in the window) — check with Hubble (a voucher may have been issued twice)`,
        events: by.superseded,
      });
    }
    if (by.marked > 0) {
      out.push({
        text: `Voucher dispersal: Hubble reported activity on the ${by.marked === 1 ? 'order of 1 row' : `orders of ${intIN(by.marked)} rows`} marked "not bought" (in the window) — check with Hubble (a voucher may have been issued; the row stays closed)`,
        events: by.marked,
      });
    }
    if (by.notApplied > 0) {
      out.push({
        text: `Voucher dispersal: ${plural(by.notApplied, 'order', 'orders')} Hubble completed could not be applied to ${by.notApplied === 1 ? 'its row' : 'their rows'} (in the window) — check with Hubble (a paid voucher may not have reached the person)`,
        events: by.notApplied,
      });
    }
    if (by.couldNotCheck > 0) {
      out.push({
        text: `Voucher dispersal: couldn't check ${plural(by.couldNotCheck, 'earlier order', 'earlier orders')} with Hubble — the lookup failed and no status is known yet (in the window); check ${by.couldNotCheck === 1 ? 'it' : 'them'} with Hubble`,
        events: by.couldNotCheck,
      });
    }
    if ((by.noOrderUnverified ?? 0) > 0) {
      out.push({
        text: `Voucher dispersal: Hubble said "no order" for ${plural(by.noOrderUnverified, 'order', 'orders')} but it could not be verified yet (in the window) — kept open and re-checked automatically`,
        events: by.noOrderUnverified,
      });
    }
  }
  // Every alert still OPEN (any age) — an attention item each day until Hubble resolves it (release-gate review).
  const open = d.earlierOrderAlertsOpenBy;
  if (open && (d.earlierOrderAlertsOpen ?? 0) > 0) {
    const parts = [
      open.superseded ? plural(open.superseded, 'earlier order', 'earlier orders') : null,
      open.marked ? plural(open.marked, 'marked row', 'marked rows') : null,
      open.notApplied ? plural(open.notApplied, 'order not applied', 'orders not applied') : null,
      open.couldNotCheck ? `${intIN(open.couldNotCheck)} couldn't check` : null,
      open.noOrderUnverified ? `${intIN(open.noOrderUnverified)} no order (unverified)` : null,
    ].filter(Boolean);
    out.push({
      text: `Voucher dispersal: still open: ${plural(d.earlierOrderAlertsOpen!, 'order alert', 'order alerts')} (${parts.join(', ')}) — open until Hubble confirms the order failed / there is no order; see the campaign pages`,
      events: d.earlierOrderAlertsOpen!,
    });
  }
  if (!by && (d.earlierOrderAlerts ?? 0) > 0) {
    out.push({
      text: `Voucher dispersal: Hubble reported activity on ${plural(d.earlierOrderAlerts!, 'earlier order', 'earlier orders')} after a retry or a "not bought" mark (in the window) — check with Hubble (a voucher may have been issued twice, or a paid voucher may not have reached the person)`,
      events: d.earlierOrderAlerts!,
    });
  }
  if ((d.unrecognisedStatus ?? 0) > 0) {
    out.push({
      text: `Voucher dispersal: ${plural(d.unrecognisedStatus!, 'purchase', 'purchases')} with a Hubble status we do not recognise — needs Gifsy tech`,
      events: d.unrecognisedStatus!,
    });
  }
  if ((d.lateCompleted ?? 0) > 0) {
    out.push({
      text: `Voucher dispersal: ${plural(d.lateCompleted!, 'purchase', 'purchases')} bought later by Hubble after ${d.lateCompleted === 1 ? 'it' : 'they'} had failed / been refused (in the window)`,
      events: d.lateCompleted!,
    });
  }
  return out;
}

/** Gifsy-wide bullets (text only). */
export function gifsyWideAttention(input: Pick<DigestInput, 'voucherDispersal' | 'gifsyOtpFailed' | 'runNotices' | 'authEvents'>): string[] {
  return gifsyWideItems(input).map((a) => a.text);
}

const SECTION_KEYS: Array<[keyof TenantDigest, string]> = [
  ['kyc', 'KYC'],
  ['points', 'Points'],
  ['redemptions', 'Redemptions'],
  ['vouchers', 'Vouchers (Hubble)'],
  ['payouts', 'Payouts'],
  ['messages', 'Messages'],
  ['visibility', 'Visibility'],
  ['location', 'Location'],
  ['salesImport', 'Sales Import'],
  ['billing', 'Billing progress'],
  // A failed TDS (194R excess) section makes the run DEGRADED like any other section.
  ['tds', 'TDS (194R)'],
  ['heldBalances', 'Held opening balances'],
  ['fund', 'Fund'],
];

/**
 * Every part of the digest that did not load (a failed tenant section, the Gifsy-wide OTP or voucher-dispersal
 * section, or a shared input from `sharedFailures`). Any entry makes the run DEGRADED (window not advanced).
 * `key` is stable across runs (for the consecutive-failure streak); `label` is for people.
 */
export function failedSections(input: DigestInput): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [...(input.sharedFailures ?? [])];
  for (const t of input.tenants) {
    for (const [k, label] of SECTION_KEYS) {
      const r = t[k] as SectionResult<unknown> | undefined;
      if (r && typeof r === 'object' && 'ok' in r && !r.ok) out.push({ key: `${t.clientId}/${String(k)}`, label: `${t.name}: ${label}` });
    }
  }
  if (input.gifsyOtpFailed && !input.gifsyOtpFailed.ok) out.push({ key: 'gifsy/otp', label: 'Gifsy-wide OTP failures' });
  if (input.voucherDispersal && !input.voucherDispersal.ok) out.push({ key: 'gifsy/voucher-dispersal', label: 'Voucher dispersal' });
  if (input.authEvents && !input.authEvents.ok) out.push({ key: 'gifsy/auth-events', label: 'Sign-in security events' });
  return out;
}

// ── Rendering helpers ─────────────────────────────────────────────────────────────────────────

const MUTED = '#6b7280';

/** "Label  a · b · c" — one compact metric line; every part escaped. */
function metricLine(label: string, parts: Array<[string, string, ('red' | 'amber')?]>): string {
  const body = parts
    .map(([k, v, accent]) => {
      const color = accent === 'red' ? '#b91c1c' : accent === 'amber' ? '#b45309' : '#111827';
      return `${esc(k)} <strong style="color:${color};">${esc(v)}</strong>`;
    })
    .join(' <span style="color:#d1d5db;">·</span> ');
  return `<div style="font-size:13px;color:#374151;margin:0 0 6px;line-height:1.6;"><span style="display:inline-block;min-width:110px;color:${MUTED};font-weight:600;">${esc(label)}</span>${body}</div>`;
}

function subHeading(text: string): string {
  return `<div data-section="${esc(text)}" style="font-size:12px;font-weight:700;color:#374151;text-transform:uppercase;letter-spacing:.04em;margin:14px 0 6px;">${esc(text)}</div>`;
}

function sectionError(label: string, error: string): string {
  return (
    subHeading(label) +
    `<div style="font-size:13px;color:#b91c1c;margin:0 0 6px;">Couldn't load this section${error ? ` (${esc(error)})` : ''}.</div>`
  );
}

const accentIf = (n: number, accent: 'red' | 'amber'): 'red' | 'amber' | undefined => (n > 0 ? accent : undefined);

function bucketParts(b: SlaBucket): Array<[string, string, ('red' | 'amber')?]> {
  return [
    ['pending', intIN(b.pending)],
    ['within SLA', intIN(b.within)],
    ['nearing', intIN(b.nearing), accentIf(b.nearing, 'amber')],
    ['breached', intIN(b.breached), accentIf(b.breached, 'red')],
  ];
}

/** Render one section: error → error line; empty → '' (hidden); else the body. */
function renderSection<T>(
  label: string,
  r: SectionResult<T> | undefined,
  isEmpty: (d: T) => boolean,
  body: (d: T) => string,
): string {
  if (!r) return '';
  if (!r.ok) return sectionError(label, r.error);
  if (isEmpty(r.data)) return '';
  return subHeading(label) + body(r.data);
}

const kycEmpty = (k: KycSection) =>
  k.submitted === 0 &&
  k.approved === 0 &&
  k.rejected === 0 &&
  k.field.pending === 0 &&
  k.gifsy.pending === 0 &&
  k.fieldFastTrackedExcluded === 0;

/** Digest note for an emergency-off tenant (features.requireLocation === false). */
export const LOCATION_SWITCHED_OFF_NOTE =
  '"Require location" is currently switched OFF for this client (emergency off) — new KYC and visibility submissions may have no location.';

const note = (text: string, color = MUTED) => `<div style="font-size:12px;color:${color};margin:0 0 6px;">${esc(text)}</div>`;

/** The owner's one-line held-opening-balance summary (exact wording, 2026-11-21). */
export function heldBalancesLine(h: HeldBalancesSection): string {
  const since = h.windowLabel ? `since the last report (${h.windowLabel.replace(' → ', ' – ')})` : 'since the last report';
  const w = h.waitingByState;
  const parts = w
    ? [
        w.NOT_ON_PORTAL ? `${intIN(w.NOT_ON_PORTAL)} not on portal` : null,
        w.AWAITING_KYC ? `${intIN(w.AWAITING_KYC)} on portal awaiting first KYC` : null,
        w.WALLET_EMPTY ? `${intIN(w.WALLET_EMPTY)} wallet empty — applying` : null,
        w.NEEDS_APPLY_NOW ? `${intIN(w.NEEDS_APPLY_NOW)} wallet has activity — needs Apply now` : null,
        w.AMBIGUOUS_OUTLET ? `${intIN(w.AMBIGUOUS_OUTLET)} outlet code matches more than one outlet` : null,
        h.retrying ? `${intIN(h.retrying)} retrying after a temporary error` : null,
      ].filter(Boolean)
    : [];
  return (
    `Held opening balances: ${intIN(h.appliedInWindow)} applied ${since} (${intIN(h.appliedInWindowPoints)} pts), ` +
    `${intIN(h.waiting)} still waiting (${intIN(h.waitingPoints)} pts)${parts.length ? ` [${parts.join('; ')}]` : ''}, ` +
    `${intIN(h.failed)} failed` +
    (h.failed > 0 ? ` (${intIN(h.failedPoints)} pts)` : '') +
    '.'
  );
}

/** The fund line: balance · committed · LOW (threshold) — every part escaped by metricLine. */
export function fundParts(f: FundSection): Array<[string, string, ('red' | 'amber')?]> {
  const parts: Array<[string, string, ('red' | 'amber')?]> = [
    ['balance', rupees(f.balancePaise), f.isLow || f.balancePaise < 0n ? 'red' : undefined],
    ['committed, not yet paid', rupees(f.committedPaise)],
  ];
  if (f.thresholdPaise != null) parts.push([f.isLow ? 'LOW — threshold' : 'threshold', rupees(f.thresholdPaise), f.isLow ? 'red' : undefined]);
  if (!f.hasOpening) parts.push(['opening balance', 'not recorded', 'amber']);
  return parts;
}

/** Today's low-balance e-mail outcome, in words. */
export function fundAlertNote(f: FundSection): string {
  const a = f.alert!;
  switch (a.status) {
    case 'sent':
      return `Low-balance e-mail sent to ${plural(a.recipients ?? 0, 'recipient', 'recipients')}.`;
    case 'sent-to-test-address':
      return 'Low-balance e-mail sent to the TEST address only (this server does not e-mail clients).';
    case 'no-threshold':
      return 'No low-balance threshold set — no e-mail.';
    case 'no-opening':
      return 'No opening balance yet — low-balance e-mails start once it is recorded.';
    case 'client-inactive':
      return 'Client is not active — no low-balance e-mail.';
    case 'not-checked-time-budget':
      return 'NOT checked today — the low-balance step ran out of time.';
    case 'test-recipient-not-internal':
      return `Low-balance e-mail NOT sent: ${a.error ?? 'the test address is not internal'}.`;
    case 'disabled-in-environment':
      return 'Client e-mails are switched off on this server — no e-mail.';
    case 'already-sent-today':
      return 'Low-balance e-mail already sent today.';
    case 'not-low':
      return 'Balance above the threshold — no e-mail.';
    case 'no-recipients':
      return 'No alert recipients configured — no e-mail.';
    case 'email-not-configured':
    case 'failed':
      return `Low-balance e-mail NOT sent: ${a.error ?? a.status}.`;
    default:
      return a.status;
  }
}

/** Billing progress block (always rendered when present: an empty month is itself worth saying). */
function billingBody(b: BillingSection): string {
  const month = monthLabel(b.month);
  if (b.kpiLabel === null) {
    return note(`No enabled KPI for this tenant — billing progress for ${month} can't be shown.`, '#b45309');
  }
  const lines: string[] = [];
  if (b.withTarget === 0) {
    lines.push(note(`No outlet has a ${b.kpiLabel} target for ${month} — nothing to measure.`, '#b45309'));
  } else {
    lines.push(
      metricLine(month, [
        ['not started billing', `${intIN(b.notStarted)} of ${intIN(b.withTarget)} with a target`, accentIf(b.notStarted, 'amber')],
      ]),
    );
  }
  lines.push(note(b.asOf ? `KPI ${b.kpiLabel} · data up to ${formatDateIST(new Date(`${b.asOf}T00:00:00+05:30`))}` : `KPI ${b.kpiLabel} · no sales uploaded for ${month} yet`));
  const notCounted: string[] = [];
  if (b.noTarget > 0) notCounted.push(plural(b.noTarget, 'outlet has no target', 'outlets have no target'));
  if (b.notCovered > 0) notCounted.push(plural(b.notCovered, 'outlet is outside the KPI’s scope', 'outlets are outside the KPI’s scope'));
  if (b.targetsOutsideRoster > 0) {
    notCounted.push(plural(b.targetsOutsideRoster, 'target is for an outlet not in the live roster', 'targets are for outlets not in the live roster'));
  }
  if (notCounted.length > 0) lines.push(note(`Not counted above: ${notCounted.join('; ')}.`));
  return lines.join('');
}

const dispersalEmpty = (d: VoucherDispersalSection) =>
  d.bought === 0 &&
  d.buyFailed === 0 &&
  d.messageFailed === 0 &&
  d.pending === 0 &&
  d.buyFailedOpen === 0 &&
  d.messageFailedOpen === 0 &&
  !d.overBudgetCampaigns &&
  !d.settleErrorCampaigns &&
  !d.earlierOrderAlerts &&
  !d.earlierOrderAlertsResolved &&
  !d.earlierOrderAlertsOpen &&
  !d.unrecognisedStatus &&
  !d.markedClosed &&
  !d.lateCompleted;

/** Gifsy-wide Voucher Dispersal block for the summary ('' when every figure is zero). */
function dispersalBlock(r: SectionResult<VoucherDispersalSection> | undefined): string {
  return renderSection('Voucher dispersal (Gifsy-wide)', r, dispersalEmpty, (d) =>
    metricLine('In window', [
      ['bought', intIN(d.bought)],
      ['purchase failed', intIN(d.buyFailed), accentIf(d.buyFailed, 'red')],
      ['WhatsApp failed', intIN(d.messageFailed), accentIf(d.messageFailed, 'red')],
      ['bought later after failing', intIN(d.lateCompleted ?? 0), accentIf(d.lateCompleted ?? 0, 'red')],
      ['earlier order reported by Hubble', intIN(d.earlierOrderAlerts ?? 0), accentIf(d.earlierOrderAlerts ?? 0, 'red')],
      ['earlier-order alert resolved (Hubble: failed / no order)', intIN(d.earlierOrderAlertsResolved ?? 0)],
    ]) +
    metricLine('Right now', [
      ['pending', intIN(d.pending), accentIf(d.pending, 'amber')],
      ['unconfirmed > 2 h', intIN(d.pendingRetryable), accentIf(d.pendingRetryable, 'red')],
      ['purchase still failed', intIN(d.buyFailedOpen), accentIf(d.buyFailedOpen, 'red')],
      ['WhatsApp still failed', intIN(d.messageFailedOpen), accentIf(d.messageFailedOpen, 'red')],
      ['campaigns over budget', intIN(d.overBudgetCampaigns ?? 0), accentIf(d.overBudgetCampaigns ?? 0, 'red')],
      ['status update failing', intIN(d.settleErrorCampaigns ?? 0), accentIf(d.settleErrorCampaigns ?? 0, 'red')],
      ['Hubble status not recognised', intIN(d.unrecognisedStatus ?? 0), accentIf(d.unrecognisedStatus ?? 0, 'red')],
      ['order alerts still open', intIN(d.earlierOrderAlertsOpen ?? 0), accentIf(d.earlierOrderAlertsOpen ?? 0, 'red')],
      ['closed (marked not bought)', intIN(d.markedClosed ?? 0)],
    ]),
  );
}

/** All the (non-empty / failed) section blocks of one tenant, concatenated. '' = nothing to show. */
function tenantSections(t: TenantDigest): string {
  return [
    renderSection('KYC', t.kyc, kycEmpty, (k) =>
      metricLine('In window', [
        ['submitted', intIN(k.submitted)],
        ['approved', intIN(k.approved)],
        ['rejected', intIN(k.rejected)],
      ]) +
      (k.field.pending > 0 ? metricLine('Field stage', bucketParts(k.field)) : '') +
      (k.gifsy.pending > 0
        ? metricLine('Gifsy stage', [
            ...bucketParts(k.gifsy),
            ...(k.gifsyFastTracked > 0
              ? ([['of which fast-tracked (skipped field)', intIN(k.gifsyFastTracked)]] as Array<[string, string]>)
              : []),
          ])
        : '') +
      (k.fieldFastTrackedExcluded > 0
        ? note(
            `${plural(k.fieldFastTrackedExcluded, 'fast-tracked KYC is', 'fast-tracked KYCs are')} at a field stage — left out of the field SLA (they skipped the field chain).`,
            '#b91c1c',
          )
        : ''),
    ),
    renderSection(
      'Points',
      t.points,
      (p) =>
        p.credited === 0 && p.redeemed === 0 && p.expired === 0 && p.negativeWallets === 0 &&
        !p.walletsNotSequenced && !p.walletsBlocked,
      (p) =>
        metricLine('In window', [
          ['credited', intIN(p.credited)],
          ['redeemed', intIN(p.redeemed)],
          ['expired', intIN(p.expired)],
        ]) +
        (p.negativeWallets > 0
          ? metricLine('Wallets', [
              ['negative', intIN(p.negativeWallets), 'red'],
              ...(p.owedPoints ? [['pts owed', intIN(p.owedPoints), 'red'] as [string, string, 'red']] : []),
            ])
          : '') +
        (p.walletsNotSequenced || p.walletsBlocked
          ? metricLine('Not ready for reversals', [
              ...(p.walletsNotSequenced
                ? [['backfill not run', intIN(p.walletsNotSequenced), 'red'] as [string, string, 'red']]
                : []),
              ...(p.walletsBlocked ? [['blocked', intIN(p.walletsBlocked), 'red'] as [string, string, 'red']] : []),
            ])
          : ''),
    ),
    renderSection(
      'Redemptions',
      t.redemptions,
      (r) => r.requested === 0 && r.completed === 0 && r.failed === 0 && r.failedNotRefunded === 0,
      (r) =>
        metricLine('In window', [
          ['requested', intIN(r.requested)],
          ['completed', intIN(r.completed)],
          ['failed', intIN(r.failed), accentIf(r.failed, 'red')],
        ]) +
        (r.failedNotRefunded > 0
          ? metricLine('Right now', [['failed, points not refunded', intIN(r.failedNotRefunded), 'red']])
          : '') +
        (r.failedRows.length > 0
          ? table(
              [{ label: 'Outlet' }, { label: 'Reward' }, { label: 'Reason' }],
              r.failedRows.slice(0, MAX_FAILED_REDEMPTION_ROWS).map((f) => [esc(f.outlet), esc(f.reward), esc(f.reason || '—')]),
            ) +
            (r.failed > Math.min(r.failedRows.length, MAX_FAILED_REDEMPTION_ROWS)
              ? `<div style="font-size:12px;color:${MUTED};margin:0 0 6px;">Showing the latest ${esc(intIN(Math.min(r.failedRows.length, MAX_FAILED_REDEMPTION_ROWS)))} of ${esc(intIN(r.failed))}.</div>`
              : '')
          : ''),
    ),
    renderSection(
      t.hubbleEnabled === false ? 'Vouchers (Hubble) — integration switched off' : 'Vouchers (Hubble)',
      t.vouchers,
      (v) => v.issued === 0 && v.failed === 0 && v.stuckProcessing === 0 && v.needsReconcile === 0,
      (v) =>
        metricLine('In window', [
          ['issued', intIN(v.issued)],
          ['failed', intIN(v.failed), accentIf(v.failed, 'red')],
        ]) +
        metricLine('Right now', [
          ['stuck > 30 min', intIN(v.stuckProcessing), accentIf(v.stuckProcessing, 'red')],
          ['needs reconcile', intIN(v.needsReconcile), accentIf(v.needsReconcile, 'red')],
        ]),
    ),
    renderSection(
      'Payouts',
      t.payouts,
      (p) =>
        p.batchesConfirmed === 0 &&
        p.creditPaid === 0 &&
        p.creditSettledByTds === 0 &&
        p.redemptionPaid === 0 &&
        p.failedOrReturned === 0 &&
        p.awaitingUtr === 0 &&
        p.openFailedCredit === 0 &&
        p.openFailedRedemption === 0,
      (p) =>
        (p.batchesConfirmed > 0
          ? metricLine('Batches', [
              ['confirmed', intIN(p.batchesConfirmed)],
              ['outlets', intIN(p.batchOutlets)],
              ['points', intIN(p.batchPoints)],
              ['payout committed', rupees(p.batchPayoutPaise)],
            ])
          : '') +
        metricLine('Paid', [
          ['credit payouts', `${intIN(p.creditPaid)} (${rupees(p.creditPaidPaise)})`],
          ['redemption payouts', `${intIN(p.redemptionPaid)} (${rupees(p.redemptionPaidPaise)})`],
          ...(p.creditSettledByTds > 0
            ? ([['settled by TDS withholding (₹0 to the retailer)', `${intIN(p.creditSettledByTds)} (${rupees(p.creditSettledByTdsPaise)})`]] as Array<[string, string]>)
            : []),
        ]) +
        metricLine('Issues', [
          ['failed / returned', intIN(p.failedOrReturned), accentIf(p.failedOrReturned, 'red')],
          ['awaiting UTR', `${intIN(p.awaitingUtr)} (${rupees(p.awaitingUtrPaise)})`, accentIf(p.awaitingUtr, 'amber')],
        ]) +
        (p.openFailedCredit + p.openFailedRedemption > 0
          ? metricLine('Still open', [
              ['credit failed (re-bank / reverse)', `${intIN(p.openFailedCredit)} (${rupees(p.openFailedCreditPaise)})`, accentIf(p.openFailedCredit, 'red')],
              ['redemption failed, no refund', intIN(p.openFailedRedemption), accentIf(p.openFailedRedemption, 'red')],
            ])
          : ''),
    ),
    renderSection(
      'Messages — delivery failures',
      t.messages,
      (m) => m.otpFailed + m.smsFailed + m.whatsappFailed + m.broadcastFailed === 0,
      (m) =>
        metricLine('Failed', [
          ['OTP', intIN(m.otpFailed), accentIf(m.otpFailed, 'red')],
          ['SMS', intIN(m.smsFailed), accentIf(m.smsFailed, 'red')],
          ['WhatsApp', intIN(m.whatsappFailed), accentIf(m.whatsappFailed, 'red')],
          ['WhatsApp broadcasts', intIN(m.broadcastFailed), accentIf(m.broadcastFailed, 'red')],
        ]),
    ),
    renderSection(
      'Visibility',
      t.visibility,
      (v) => v.submitted === 0 && v.approved === 0 && v.rejected === 0 && v.pending === 0,
      (v) =>
        v.month !== undefined
          ? // PHOTO_APPROVAL tenants: reviews done in the window (one per capture per day) + the open queues right
            // now — Gifsy's whole review queue (any month) and what waits on reps (open windows only).
            metricLine('In window', [
              ['submitted', intIN(v.submitted)],
              ['reviews done (one per capture per day, its final outcome)', intIN(v.reviewActions ?? v.approved + v.rejected)],
              ['approved', intIN(v.approved)],
              ['sent back / rejected', intIN(v.rejected)],
            ]) +
            metricLine('Right now', [
              [
                VISIBILITY_WORDS.WAITING.toLowerCase(),
                `${intIN(v.waitingAllMonths ?? v.waiting ?? 0)}${
                  (v.waitingEarlierMonths ?? 0) > 0 ? ` (${intIN(v.waitingEarlierMonths ?? 0)} from earlier months)` : ''
                }`,
                accentIf(v.waitingAllMonths ?? v.waiting ?? 0, 'amber'),
              ],
              ['waiting on reps (re-take / capture again — window still open)', intIN(v.waitingOnReps ?? v.needsRetake ?? 0)],
              ...((v.closedNotApproved ?? 0) > 0
                ? ([[`${VISIBILITY_WORDS.CLOSED_NOT_APPROVED.toLowerCase()} (${monthLabel(v.month)})`, intIN(v.closedNotApproved ?? 0)]] as Array<[string, string]>)
                : []),
            ])
          : metricLine('In window', [
          ['submitted', intIN(v.submitted)],
          ['approved', intIN(v.approved)],
          ['rejected', intIN(v.rejected)],
        ]) + metricLine('Right now', [['pending review', intIN(v.pending), accentIf(v.pending, 'amber')]]),
    ),
    // Location compliance (LOCATION-GATE.md): shown for every tenant with "Require location" ON (the default), and for an
    // emergency-off tenant whenever the window had activity — with a loud "switched off" note (history never hidden).
    renderSection(
      'Location',
      t.location,
      (l) => !l.requireLocation && l.kycs === 0 && l.captures === 0 && l.blockedOutside === 0,
      (l) =>
        (l.requireLocation
          ? note('"Require location" is ON — reps cannot start or submit a KYC or visibility capture without a location fix.')
          : note(LOCATION_SWITCHED_OFF_NOTE, '#b45309')) +
        metricLine('In window', [
          ['KYCs', intIN(l.kycs)],
          ['visibility captures', intIN(l.captures)],
          ['without GPS', intIN(l.noGps), accentIf(l.noGps, 'amber')],
          ['accuracy worse than 50 m', intIN(l.poorAccuracy), accentIf(l.poorAccuracy, 'amber')],
          ...(l.requireLocation || l.blockedOutside > 0
            ? ([['blocked outside the 200 m fence', intIN(l.blockedOutside), accentIf(l.blockedOutside, 'amber')]] as Array<[string, string, ('red' | 'amber')?]>)
            : []),
        ]),
    ),
    renderSection(
      'Sales Import',
      t.salesImport,
      (s) => s.processed === 0 && s.failed === 0 && s.failedOpen === 0 && !s.openMonths.some((m) => m.targetsChangedSinceApply),
      (s) =>
        metricLine('In window', [
          ['processed', intIN(s.processed)],
          ['failed', intIN(s.failed), accentIf(s.failed, 'red')],
        ]) +
        (s.failedOpen > 0 ? metricLine('Right now', [['failed, not yet replaced', intIN(s.failedOpen), 'red']]) : '') +
        (s.openMonths.length > 0
          ? table(
              [{ label: 'Open month' }, { label: 'Last applied' }, { label: 'Targets changed since apply' }],
              s.openMonths.map((m) => [
                esc(monthLabel(m.month)),
                esc(m.lastAppliedAtMs === null ? 'Never' : formatDateIST(new Date(m.lastAppliedAtMs))),
                m.targetsChangedSinceApply
                  ? `<strong style="color:#b91c1c;">${esc('Yes — recalculate')}</strong>`
                  : esc('No'),
              ]),
            )
          : ''),
    ),
    renderSection('Billing progress', t.billing, () => false, billingBody),
    // Always rendered for a tenant that HAS held rows (the collector omits the section otherwise).
    renderSection('Held opening balances', t.heldBalances, () => false, (h) => note(heldBalancesLine(h), h.failed > 0 ? '#b91c1c' : '#374151')),
    // Client fund — always rendered for a client with a fund set-up (the collector omits it otherwise).
    renderSection('Fund', t.fund, () => false, (f) => metricLine('Fund', fundParts(f)) + (f.alert ? note(fundAlertNote(f), f.alert.status === 'failed' || f.alert.status === 'email-not-configured' ? '#b91c1c' : MUTED) : '')),
    renderSection(
      'TDS (194R)',
      t.tds,
      (x) => x.excessRetailerCount === 0,
      (x) =>
        metricLine(`Taken in excess (${x.fyLabel}, flag only — no refund)`, [
          ['retailers', intIN(x.excessRetailerCount), 'amber'],
          ['total', rupees(x.totalExcessPaise), 'amber'],
        ]) +
        table(
          [{ label: 'Retailer' }, { label: 'Taken in excess' }],
          x.sample.map((r) => [esc(r.retailer), esc(rupees(r.excessPaise))]),
        ),
    ),
  ].join('');
}

function tenantBlock(t: TenantDigest, attention: string[]): string {
  const badge =
    attention.length > 0
      ? `<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#fef2f2;color:#b91c1c;font-size:12px;font-weight:700;">${esc(plural(attention.length, 'needs attention', 'need attention'))}</span>`
      : '';
  const statusBadge =
    t.status && t.status !== 'ACTIVE'
      ? `<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:#f3f4f6;color:#374151;font-size:12px;font-weight:700;">${esc(t.status)}</span>`
      : '';
  const head = `<div style="font-size:16px;font-weight:700;color:#111827;margin:0 0 8px;">${esc(t.name)}${statusBadge}${badge}</div>`;
  const sections = tenantSections(t);
  const bullets =
    attention.length > 0
      ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin:0 0 8px;"><div style="font-size:12px;font-weight:700;color:#b91c1c;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;">Needs attention</div><ul style="margin:0;padding-left:18px;font-size:13px;color:#7f1d1d;">${attention
          .map((a) => `<li style="margin:2px 0;">${esc(a)}</li>`)
          .join('')}</ul></div>`
      : '';
  const body = sections === '' && attention.length === 0 ? `<div style="font-size:13px;color:${MUTED};">All quiet — nothing to report.</div>` : bullets + sections;
  return `<div data-tenant="${esc(t.clientId)}" style="border-top:1px solid #eef0f2;padding:18px 0 6px;margin-top:8px;">${head}${body}</div>`;
}

// ── Builder ───────────────────────────────────────────────────────────────────────────────────

const headline = <T,>(r: SectionResult<T> | undefined, pick: (d: T) => string): string => (r ? (r.ok ? pick(r.data) : '—') : '—');

const RED_BOX = 'background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin:8px 0;';
const RED_BOX_TITLE = 'font-size:12px;font-weight:700;color:#b91c1c;text-transform:uppercase;letter-spacing:.04em;margin:0 0 4px;';

function redList(title: string, items: string[], attr = ''): string {
  return `<div${attr} style="${RED_BOX}"><div style="${RED_BOX_TITLE}">${esc(title)}</div><ul style="margin:0;padding-left:18px;font-size:13px;color:#7f1d1d;">${items
    .map((a) => `<li style="margin:2px 0;">${esc(a)}</li>`)
    .join('')}</ul></div>`;
}

/**
 * A non-ACTIVE (ONBOARDING / INACTIVE) tenant is shown only when it has something to say: an attention
 * item, or a non-empty section (Billing progress — always rendered for Sales-Import tenants — doesn't count).
 */
function hasActivity(t: TenantDigest, attention: string[]): boolean {
  return attention.length > 0 || tenantSections({ ...t, billing: undefined }) !== '';
}

const nameWithStatus = (t: TenantDigest) => (t.status && t.status !== 'ACTIVE' ? `${t.name} (${t.status})` : t.name);

/** Render the digest. Always produces an email (an all-quiet day says so). */
export function buildDailyOpsDigest(input: DigestInput): DigestResult {
  const all = input.tenants.map((t) => {
    const items = attentionItems(t);
    return { t, attention: items.map((a) => a.text), events: items.reduce((n, a) => n + a.events, 0) };
  });
  // ACTIVE tenants always; ONBOARDING / INACTIVE ones only with activity or open items — the rest are
  // NAMED at the bottom (never silently dropped).
  const rows = all.filter(({ t, attention }) => !t.status || t.status === 'ACTIVE' || hasActivity(t, attention));
  const hidden = all.filter((r) => !rows.includes(r)).map(({ t }) => nameWithStatus(t));
  rows.sort((a, b) => b.attention.length - a.attention.length || a.t.name.localeCompare(b.t.name));

  const tenantsNeedingAttention = rows.filter((r) => r.attention.length > 0).length;
  const gifsyWideList = gifsyWideItems(input);
  const gifsyWide = gifsyWideList.map((a) => a.text);
  // EVENTS, not bullets (a merged window + still-open bullet counts its distinct lower bound).
  const totalEvents = rows.reduce((s, r) => s + r.events, 0) + gifsyWideList.reduce((s, a) => s + a.events, 0);
  const failed = failedSections(input);
  const incomplete = (input.runNotices?.length ?? 0) > 0 || failed.length > 0;
  const streak = input.incompleteStreak && input.incompleteStreak.runs >= PERSISTENT_FAILURE_RUNS ? input.incompleteStreak : null;

  const summaryTable = table(
    [
      { label: 'Tenant' },
      { label: 'Needs attention', align: 'right' },
      { label: 'KYC pending', align: 'right' },
      { label: 'Redemptions', align: 'right' },
      { label: 'Points credited', align: 'right' },
      { label: 'Payouts paid', align: 'right' },
    ],
    rows.map(({ t, events }) => [
      esc(nameWithStatus(t)),
      events > 0 ? `<strong style="color:#b91c1c;">${esc(intIN(events))}</strong>` : esc('0'),
      esc(headline(t.kyc, (k) => intIN(k.field.pending + k.gifsy.pending))),
      esc(headline(t.redemptions, (r) => intIN(r.requested))),
      esc(headline(t.points, (p) => intIN(p.credited))),
      esc(headline(t.payouts, (p) => intIN(p.creditPaid + p.redemptionPaid))),
    ]),
    'No tenants to show.',
  );

  // "All quiet" only when there is NOTHING red anywhere: no tenant item, no Gifsy-wide item (incl. OTP
  // failures and run notices).
  const allQuiet = totalEvents === 0;
  const incompleteLines = [
    ...(input.runNotices ?? []),
    ...(failed.length > (input.sharedFailures?.length ?? 0)
      ? [`Not loaded: ${failed.slice(input.sharedFailures?.length ?? 0).map((f) => f.label).join('; ')} — those figures are missing below and will be repeated in the next digest.`]
      : []),
    ...(streak ? [`${streak.sections.join('; ')} failed to load ${intIN(streak.runs)} runs in a row.`] : []),
  ];
  const runNoticeBox = incomplete ? redList('This digest is incomplete', incompleteLines, ' data-run-notices="1"') : '';
  const repeatBox = input.repeatNotice
    ? `<div data-repeat-notice="1" style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin:8px 0;font-size:13px;font-weight:600;color:#92400e;">${esc(input.repeatNotice)}</div>`
    : '';
  const otherGifsyWide = gifsyWide.slice(input.runNotices?.length ?? 0);
  const gifsyWideBox = otherGifsyWide.length > 0 ? redList('Needs attention — Gifsy-wide', otherGifsyWide) : '';
  const summary =
    repeatBox +
    runNoticeBox +
    sectionHeading('All tenants') +
    statRow([
      { label: 'Tenants', value: intIN(rows.length) },
      { label: 'Need attention', value: intIN(tenantsNeedingAttention), accent: tenantsNeedingAttention > 0 ? 'red' : 'green' },
      { label: 'Attention items', value: intIN(totalEvents), accent: totalEvents > 0 ? 'red' : 'green' },
    ]) +
    (allQuiet
      ? `<div style="font-size:14px;font-weight:600;color:#047857;margin:6px 0 10px;">All quiet — nothing needs attention.</div>`
      : '') +
    summaryTable +
    gifsyWideBox +
    dispersalBlock(input.voucherDispersal);

  const hiddenNote =
    hidden.length > 0
      ? `<div style="font-size:12px;color:${MUTED};margin:12px 0 0;">${esc(
          `Not shown (not ACTIVE, no activity and no open items): ${hidden.join(', ')}.`,
        )}</div>`
      : '';
  const body = summary + sectionHeading('By tenant') + rows.map(({ t, attention }) => tenantBlock(t, attention)).join('') + hiddenNote;

  const windowNotes = (input.windowNotes ?? []).filter((n) => n.trim() !== '');
  const html = emailShell({
    title: 'Daily operations digest',
    intro: `Window: ${input.window.label}${windowNotes.length > 0 ? ` — ${windowNotes.join(' ')}` : ''}`,
    body,
    dateLabel: input.dateLabel,
    footerNote:
      input.droppedRecipients && input.droppedRecipients.length > 0
        ? `Not sent to ${input.droppedRecipients.join(', ')} — not an internal address (only internal Gifsy addresses may receive this digest). Remove ${input.droppedRecipients.length === 1 ? 'it' : 'them'} in Gifsy Settings → Report Recipients.`
        : undefined,
  });

  // Subject: never "all quiet" while the body shows a red problem — the count is every attention EVENT
  // (tenant items + Gifsy-wide items incl. OTP failures, standing open items and run notices).
  const where = [
    tenantsNeedingAttention > 0 ? plural(tenantsNeedingAttention, 'tenant', 'tenants') : null,
    gifsyWide.length > 0 ? 'Gifsy-wide' : null,
  ]
    .filter(Boolean)
    .join(' + ');
  const status =
    totalEvents === 0
      ? 'all quiet'
      : `${intIN(totalEvents)} ${totalEvents === 1 ? 'item needs' : 'items need'} attention (${where})`;
  const incompleteTag = streak ? `INCOMPLETE ${intIN(streak.runs)} days — ` : incomplete ? 'INCOMPLETE — ' : '';

  return {
    key: 'dailyDigest',
    subject: `[Gifsy] Daily operations — ${input.dateLabel} — ${incompleteTag}${status}`,
    html,
    tenantsNeedingAttention,
    attentionItems: totalEvents,
    failedSections: failed,
    gifsyWideItems: gifsyWide.length,
    hiddenTenants: hidden.length,
  };
}
