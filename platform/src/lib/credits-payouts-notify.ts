/**
 * Credits & Payouts — Notifications
 *
 * WhatsApp (MSG91) notifications:
 *  - notifyPointsCredited   → outlet when points batch is confirmed
 *  - notifyPayoutConfirmed  → outlet when UTR is uploaded (payment confirmed)
 *
 * Email notifications (MSG91 email API / SMTP):
 *  - notifyGifsyNewBatch    → Gifsy team when client admin confirms a batch
 *
 * In DEMO_MODE (no MSG91_AUTH_KEY) all calls log to console and return success.
 * Template IDs are configurable via env vars; placeholders used when unset.
 */

import { sendWhatsApp } from './msg91';

// ─── Template IDs (configurable via env) ─────────────────────────────────────

function whatsappTemplateId(key: string, fallback: string): string {
  if (typeof process !== 'undefined') {
    const val = (process.env as Record<string, string | undefined>)[key];
    if (val) return val;
  }
  return fallback;
}

export const TEMPLATE_POINTS_CREDITED  = () =>
  whatsappTemplateId('NEXT_PUBLIC_MSG91_CREDITS_TEMPLATE_ID',  'credits_credited_v1');
export const TEMPLATE_PAYOUT_CONFIRMED = () =>
  whatsappTemplateId('NEXT_PUBLIC_MSG91_PAYOUT_TEMPLATE_ID',   'payout_confirmed_v1');

// ─── Demo email check ─────────────────────────────────────────────────────────

function isEmailDemoMode(): boolean {
  if (typeof process === 'undefined') return true;
  if (!process.env.MSG91_AUTH_KEY)    return true;
  if (process.env.NEXT_PUBLIC_DEMO_MSG91 === 'true') return true;
  return false;
}

// ─── WhatsApp: Points credited ────────────────────────────────────────────────

export interface PointsCreditedPayload {
  phone:       string;
  outletName:  string;
  totalPoints: number;
  period:      string;   // 'YYYY-MM'
}

/**
 * Sends a WhatsApp message to an outlet when their points are credited.
 * Template variables: {{1}} = outletName, {{2}} = totalPoints, {{3}} = period label
 */
export async function notifyPointsCredited(
  payload: PointsCreditedPayload,
): Promise<{ success: boolean; channel: string; error?: string }> {
  const [y, m] = payload.period.split('-').map(Number);
  const label  = new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const result = await sendWhatsApp({
    phone:      payload.phone,
    templateId: TEMPLATE_POINTS_CREDITED(),
    variables: {
      '{{1}}': payload.outletName,
      '{{2}}': String(payload.totalPoints),
      '{{3}}': label,
    },
  });

  return { success: result.success, channel: 'whatsapp', error: result.error };
}

// ─── WhatsApp: Payout confirmed (UTR uploaded) ────────────────────────────────

export interface PayoutConfirmedPayload {
  phone:      string;
  outletName: string;
  amountInr:  number;
  utr:        string;
  period:     string;
}

/**
 * Sends a WhatsApp message to an outlet when their payout is confirmed.
 * Template variables: {{1}} = outletName, {{2}} = amount, {{3}} = UTR, {{4}} = period label
 */
export async function notifyPayoutConfirmed(
  payload: PayoutConfirmedPayload,
): Promise<{ success: boolean; channel: string; error?: string }> {
  const [y, m] = payload.period.split('-').map(Number);
  const label  = new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const result = await sendWhatsApp({
    phone:      payload.phone,
    templateId: TEMPLATE_PAYOUT_CONFIRMED(),
    variables: {
      '{{1}}': payload.outletName,
      '{{2}}': `₹${payload.amountInr.toLocaleString('en-IN')}`,
      '{{3}}': payload.utr,
      '{{4}}': label,
    },
  });

  return { success: result.success, channel: 'whatsapp', error: result.error };
}

// ─── Email: Notify Gifsy when client admin confirms a batch ──────────────────

export interface GifsyBatchNotifyPayload {
  tenantName:     string;
  period:         string;
  batchId:        string;
  totalOutlets:   number;
  totalPoints:    number;
  totalPayoutInr: number;
  uploadedBy:     string;
  recipientEmails: string[];
}

/**
 * Sends an email to the Gifsy team when a client admin confirms a new batch.
 * In DEMO_MODE: logs the full email content to console.
 * In production: calls MSG91 email API (endpoint: /api/v5/email/send).
 */
export async function notifyGifsyNewBatch(
  payload: GifsyBatchNotifyPayload,
): Promise<{ success: boolean; error?: string }> {
  const [y, m] = payload.period.split('-').map(Number);
  const label  = new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  const subject = `[Gifsy] New Batch Confirmed — ${payload.tenantName} — ${label}`;
  const body    = [
    `Tenant:        ${payload.tenantName}`,
    `Period:        ${label}`,
    `Batch ID:      ${payload.batchId}`,
    `Uploaded by:   ${payload.uploadedBy}`,
    `Outlets:       ${payload.totalOutlets}`,
    payload.totalPoints    > 0 ? `Total Points:  ${payload.totalPoints.toLocaleString('en-IN')} pts` : null,
    payload.totalPayoutInr > 0 ? `Total Payout:  ₹${payload.totalPayoutInr.toLocaleString('en-IN')}` : null,
    '',
    'Please log in to the admin portal to review and process payouts.',
  ].filter((l): l is string => l !== null).join('\n');

  if (isEmailDemoMode()) {
    console.log('[GIFSY EMAIL DEMO]', {
      to:      payload.recipientEmails,
      subject,
      body,
    });
    return { success: true };
  }

  // Production: call MSG91 email API
  try {
    const res = await fetch('https://api.msg91.com/api/v5/email/send', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        authkey: process.env.MSG91_AUTH_KEY ?? '',
      },
      body: JSON.stringify({
        recipients: payload.recipientEmails.map((email) => ({ to: [{ email }] })),
        from:       { email: 'noreply@gifsy.in', name: 'Gifsy Platform' },
        domain:     'gifsy.in',
        mail_type_id: 1,
        subject,
        body,
      }),
    });
    const data = await res.json() as Record<string, unknown>;
    if (data.message === 'success' || data.status === 'success') return { success: true };
    return { success: false, error: String(data.message ?? 'Email send failed') };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─── Batch notification helper ────────────────────────────────────────────────

/**
 * Sends WhatsApp to all unique outlets in a confirmed batch.
 * Points outlets get notifyPointsCredited; payout outlets get nothing (UTR is the trigger).
 *
 * phoneMap: { outletId → phone }
 * pointsSummary: { outletId → totalPoints }
 */
export async function notifyBatchOutlets(opts: {
  phoneMap:     Record<string, string>;
  pointsMap:    Record<string, number>;  // outletId → total points (0 = not a points outlet)
  period:       string;
  outletNames:  Record<string, string>;
}): Promise<void> {
  const { phoneMap, pointsMap, period, outletNames } = opts;
  for (const [outletId, points] of Object.entries(pointsMap)) {
    if (points <= 0) continue;
    const phone = phoneMap[outletId];
    if (!phone) continue;
    await notifyPointsCredited({
      phone,
      outletName:  outletNames[outletId] ?? outletId,
      totalPoints: points,
      period,
    });
  }
}
