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
 * Send an OTP to the given phone number via SMS or WhatsApp.
 */
export async function sendOTP(
  phone: string,
  otp: string,
  channel: 'SMS' | 'WHATSAPP'
): Promise<void> {
  if (channel === 'WHATSAPP') {
    await axios.post(
      WHATSAPP_GATEWAY_URL,
      {
        phone,
        templateName: 'otp_verification',
        params: [otp],
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_API_KEY}` } }
    );
  } else {
    await axios.post(
      SMS_GATEWAY_URL,
      {
        to: phone,
        message: `Your OTP is ${otp}. Valid for 10 minutes. Do not share it with anyone.`,
      },
      { headers: { 'x-api-key': SMS_GATEWAY_API_KEY } }
    );
  }
}

// ─── Template-based notification ──────────────────────────────────────────────

/**
 * Look up the notification template by code, interpolate the data,
 * and dispatch the message via the configured channel.
 */
export async function sendNotification(
  userId: string,
  event: NotificationEvent,
  data: Record<string, unknown>
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error(`User not found: ${userId}`);

  // Use event name as template code
  const template = await prisma.notificationTemplate.findFirst({
    where: { code: String(event), isActive: true },
  });
  if (!template) {
    console.warn(`[NOTIFICATION] No active template for event: ${event}`);
    return;
  }

  const body = interpolate(template.bodyTemplate, data);

  if (template.channel === 'SMS' && user.phone) {
    await axios.post(
      SMS_GATEWAY_URL,
      { to: user.phone, message: body },
      { headers: { 'x-api-key': SMS_GATEWAY_API_KEY } }
    );
  } else if (template.channel === 'WHATSAPP' && user.phone) {
    await axios.post(
      WHATSAPP_GATEWAY_URL,
      { phone: user.phone, message: body },
      { headers: { Authorization: `Bearer ${WHATSAPP_API_KEY}` } }
    );
  }

  // Queue as sent
  await prisma.notificationQueue.create({
    data: {
      userId,
      templateId: template.id,
      channel: template.channel,
      body,
      status: 'QUEUED',
      processedAt: new Date(),
    },
  }).catch(() => {
    // Non-critical: log and continue
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

  const body = interpolate(template.bodyTemplate, data);

  await prisma.notificationQueue.create({
    data: {
      userId,
      templateId,
      channel: template.channel,
      body,
      scheduledAt: scheduledAt ?? null,
      status: 'QUEUED',
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
