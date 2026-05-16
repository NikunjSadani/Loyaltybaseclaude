import axios from 'axios';
import { prisma } from './prisma';
import { NotificationEvent, NotificationChannel } from '@/types';

// ─── Re-export enum so existing code that imports from here still works ───────
export { NotificationChannel, NotificationEvent };

// ─── Gateway credentials ──────────────────────────────────────────────────────

const SMS_GATEWAY_URL = process.env.SMS_GATEWAY_URL ?? '';
const SMS_GATEWAY_API_KEY = process.env.SMS_GATEWAY_API_KEY ?? '';
const WHATSAPP_GATEWAY_URL = process.env.WHATSAPP_GATEWAY_URL ?? '';
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY ?? '';

// ─── OTP delivery ─────────────────────────────────────────────────────────────

/**
 * Send an OTP to the given mobile number via SMS or WhatsApp.
 */
export async function sendOTP(
  mobile: string,
  otp: string,
  channel: 'SMS' | 'WHATSAPP'
): Promise<void> {
  if (channel === 'WHATSAPP') {
    await axios.post(
      WHATSAPP_GATEWAY_URL,
      {
        phone: mobile,
        templateName: 'otp_verification',
        params: [otp],
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_API_KEY}` } }
    );
  } else {
    await axios.post(
      SMS_GATEWAY_URL,
      {
        to: mobile,
        message: `Your OTP is ${otp}. Valid for 10 minutes. Do not share it with anyone.`,
      },
      { headers: { 'x-api-key': SMS_GATEWAY_API_KEY } }
    );
  }
}

// ─── Template-based notification ──────────────────────────────────────────────

/**
 * Look up the notification template for the given event, interpolate the data,
 * and dispatch the message via the configured channel.
 */
export async function sendNotification(
  userId: string,
  event: NotificationEvent,
  data: Record<string, unknown>
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error(`User not found: ${userId}`);

  const template = await prisma.notificationTemplate.findFirst({
    where: { event, isActive: true },
  });
  if (!template) {
    console.warn(`[NOTIFICATION] No active template for event: ${event}`);
    return;
  }

  const body = interpolate(template.templateBody, data);

  if (template.channel === NotificationChannel.SMS && user.mobile) {
    await axios.post(
      SMS_GATEWAY_URL,
      { to: user.mobile, message: body },
      { headers: { 'x-api-key': SMS_GATEWAY_API_KEY } }
    );
  } else if (template.channel === NotificationChannel.WHATSAPP && user.mobile) {
    await axios.post(
      WHATSAPP_GATEWAY_URL,
      { phone: user.mobile, message: body, templateId: template.templateId },
      { headers: { Authorization: `Bearer ${WHATSAPP_API_KEY}` } }
    );
  }

  // Persist as sent
  await prisma.notificationQueue.update({
    where: {
      // best-effort: find the most recent unsent queue entry for this user+template
      id: (
        await prisma.notificationQueue.findFirst({
          where: { userId, templateId: template.id, sentAt: null },
          orderBy: { createdAt: 'desc' },
        })
      )?.id ?? '',
    },
    data: { sentAt: new Date(), status: 'SENT' },
  }).catch(() => {
    // No queued record – that's fine, fire-and-forget notifications need no queue entry.
  });
}

// ─── Queue notification ───────────────────────────────────────────────────────

/**
 * Add a notification to the queue for immediate or scheduled delivery.
 */
export async function queueNotification(
  userId: string,
  templateId: string,
  data: Record<string, unknown>,
  scheduledAt?: Date
): Promise<void> {
  const template = await prisma.notificationTemplate.findUnique({
    where: { id: templateId },
  });
  if (!template) throw new Error(`Template not found: ${templateId}`);

  await prisma.notificationQueue.create({
    data: {
      userId,
      templateId,
      channel: template.channel,
      payload: data,
      scheduledAt: scheduledAt ?? null,
      status: 'PENDING',
    },
  });
}

// ─── Legacy alias ─────────────────────────────────────────────────────────────

/** @deprecated Use sendOTP instead */
export async function sendOtp(params: {
  mobile: string;
  otp: string;
  channel: 'SMS' | 'WHATSAPP' | 'EMAIL';
}): Promise<boolean> {
  if (params.channel === 'EMAIL') return true; // email not supported via this helper
  await sendOTP(params.mobile, params.otp, params.channel as 'SMS' | 'WHATSAPP');
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    data[key] !== undefined ? String(data[key]) : `{{${key}}}`
  );
}
