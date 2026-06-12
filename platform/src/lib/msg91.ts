/**
 * MSG91 client — pure payload builders + response parsers + live API caller.
 *
 * Architecture:
 *   - buildXxxPayload()         — pure functions, fully unit-testable
 *   - parseXxxResponse()        — pure response normalizers
 *   - sendWhatsApp / sendSms /  — side-effectful callers (fetch)
 *     sendOtp / verifyOtp         In DEMO_MODE they simulate the API.
 *
 * DEMO_MODE is active when env NEXT_PUBLIC_DEMO_MSG91=true or when no
 * MSG91_AUTH_KEY is present.  In demo mode all calls resolve successfully
 * without hitting the network.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types — request payloads
// ─────────────────────────────────────────────────────────────────────────────

export interface Msg91WhatsAppTemplateComponent {
  type: 'body';
  parameters: { type: 'text'; text: string }[];
}

export interface Msg91WhatsAppPayload {
  integrated_number: string;
  content_type: 'template';
  payload: {
    messaging_product: 'whatsapp';
    to: string;
    type: 'template';
    template: {
      name: string;
      language: { code: 'en' };
      components: Msg91WhatsAppTemplateComponent[];
    };
  };
}

export interface Msg91SmsPayload {
  sender: string;
  route: '4'; // 4 = transactional
  country: string;
  sms: {
    message: string;
    to: string[];
  }[];
}

export interface Msg91OtpPayload {
  mobile: string;
  otp_length: number;
  expiry: number;    // minutes
  template_id: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — parsed responses
// ─────────────────────────────────────────────────────────────────────────────

export interface OtpSendResult {
  success: boolean;
  requestId?: string;   // MSG91 message field on success
  error?: string;
}

export interface OtpVerifyResult {
  verified: boolean;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// interpolateTemplate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replaces MSG91-style template variables ({{1}}, {{2}}, …) in a message
 * string using a mapping object.  Unmatched keys are left as-is.
 */
export function interpolateTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalisePhone
// ─────────────────────────────────────────────────────────────────────────────

function normalisePhone(phone: string, country = '91'): string {
  // Strip leading +
  let p = phone.replace(/^\+/, '');
  // If the number doesn't already start with the country code, prepend it
  if (!p.startsWith(country)) {
    p = `${country}${p}`;
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildWhatsAppPayload
// ─────────────────────────────────────────────────────────────────────────────

export function buildWhatsAppPayload(opts: {
  phone: string;
  templateId: string;
  variables: Record<string, string>;
  country?: string;
}): Msg91WhatsAppPayload {
  const mobile = normalisePhone(opts.phone, opts.country ?? '91');
  const bodyParams = Object.values(opts.variables).map((text) => ({
    type: 'text' as const,
    text,
  }));

  return {
    integrated_number: mobile,
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      to: mobile,
      type: 'template',
      template: {
        name: opts.templateId,
        language: { code: 'en' },
        components: bodyParams.length > 0
          ? [{ type: 'body', parameters: bodyParams }]
          : [],
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSmsPayload
// ─────────────────────────────────────────────────────────────────────────────

export function buildSmsPayload(opts: {
  phone: string;
  templateId: string;
  message: string;
  senderId?: string;
  country?: string;
}): Msg91SmsPayload {
  const mobile = normalisePhone(opts.phone, opts.country ?? '91');
  return {
    sender: opts.senderId ?? 'GIFSY',
    route: '4',
    country: opts.country ?? '91',
    sms: [{ message: opts.message, to: [mobile] }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildOtpPayload
// ─────────────────────────────────────────────────────────────────────────────

export function buildOtpPayload(opts: {
  phone: string;
  templateId: string;
  otpLength?: number;
  expiry?: number;
  country?: string;
}): Msg91OtpPayload {
  return {
    mobile: normalisePhone(opts.phone, opts.country ?? '91'),
    otp_length: opts.otpLength ?? 6,
    expiry: opts.expiry ?? 10,
    template_id: opts.templateId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseOtpResponse / parseVerifyOtpResponse
// ─────────────────────────────────────────────────────────────────────────────

export function parseOtpResponse(raw: unknown): OtpSendResult {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('type' in raw)
  ) {
    return { success: false, error: 'Unexpected response format from MSG91.' };
  }
  const r = raw as Record<string, unknown>;
  if (r.type === 'success') {
    return { success: true, requestId: String(r.message ?? '') };
  }
  return { success: false, error: String(r.message ?? 'Unknown MSG91 error') };
}

export function parseVerifyOtpResponse(raw: unknown): OtpVerifyResult {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('type' in raw)
  ) {
    return { verified: false, error: 'Unexpected response format from MSG91.' };
  }
  const r = raw as Record<string, unknown>;
  if (r.type === 'success') return { verified: true };
  return { verified: false, error: String(r.message ?? 'OTP verification failed') };
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo mode check
// ─────────────────────────────────────────────────────────────────────────────

function isDemoMode(): boolean {
  if (typeof process === 'undefined') return true;
  if (process.env.NEXT_PUBLIC_DEMO_MSG91 === 'true') return true;
  if (!process.env.MSG91_AUTH_KEY) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live API callers
// ─────────────────────────────────────────────────────────────────────────────

const MSG91_BASE = 'https://api.msg91.com/api/v5';

async function msg91Post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${MSG91_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authkey: process.env.MSG91_AUTH_KEY ?? '',
    },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// sendWhatsApp
// ─────────────────────────────────────────────────────────────────────────────

export async function sendWhatsApp(opts: {
  phone: string;
  templateId: string;
  variables: Record<string, string>;
  country?: string;
}): Promise<{ success: boolean; error?: string }> {
  if (isDemoMode()) {
    console.log('[MSG91 DEMO] sendWhatsApp →', opts.phone, opts.templateId, opts.variables);
    return { success: true };
  }

  const payload = buildWhatsAppPayload(opts);
  try {
    const raw = await msg91Post<Record<string, unknown>>('/whatsapp/whatsapp-outbound-message/bulk/', payload);
    if (raw.type === 'success') return { success: true };
    return { success: false, error: String(raw.message ?? 'MSG91 error') };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendSms
// ─────────────────────────────────────────────────────────────────────────────

export async function sendSms(opts: {
  phone: string;
  templateId: string;
  message: string;
  senderId?: string;
  country?: string;
}): Promise<{ success: boolean; error?: string }> {
  if (isDemoMode()) {
    console.log('[MSG91 DEMO] sendSms →', opts.phone, opts.message);
    return { success: true };
  }

  const payload = buildSmsPayload(opts);
  try {
    const raw = await msg91Post<Record<string, unknown>>('/flow/', payload);
    if (raw.type === 'success') return { success: true };
    return { success: false, error: String(raw.message ?? 'MSG91 error') };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendOtp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends an OTP to the outlet's registered phone number.
 * In DEMO_MODE the OTP is always "123456".
 */
export async function sendOtp(opts: {
  phone: string;
  templateId: string;
  otpLength?: number;
  expiry?: number;
  country?: string;
}): Promise<OtpSendResult> {
  if (isDemoMode()) {
    console.log('[MSG91 DEMO] sendOtp → demo OTP 123456 sent to', opts.phone);
    return { success: true, requestId: 'demo_request_id' };
  }

  const payload = buildOtpPayload(opts);
  try {
    const raw = await msg91Post<unknown>('/otp', payload);
    return parseOtpResponse(raw);
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// verifyOtp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the OTP entered by the outlet/employee.
 * In DEMO_MODE any 6-digit code is accepted (simulates "123456").
 */
export async function verifyOtp(opts: {
  phone: string;
  otp: string;
  country?: string;
}): Promise<OtpVerifyResult> {
  if (isDemoMode()) {
    // Demo: accept "123456" or any 6-digit code for UX testing
    if (/^\d{6}$/.test(opts.otp)) {
      console.log('[MSG91 DEMO] verifyOtp → accepted', opts.otp, 'for', opts.phone);
      return { verified: true };
    }
    return { verified: false, error: 'Demo mode: enter any 6-digit code.' };
  }

  const mobile = normalisePhone(opts.phone, opts.country ?? '91');
  try {
    const raw = await fetch(
      `${MSG91_BASE}/otp/verify?mobile=${mobile}&otp=${opts.otp}`,
      {
        headers: {
          authkey: process.env.MSG91_AUTH_KEY ?? '',
          'Content-Type': 'application/json',
        },
      },
    );
    return parseVerifyOtpResponse(await raw.json());
  } catch (err) {
    return { verified: false, error: String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: notifySchemePublished
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends a WhatsApp (with SMS fallback) to an outlet when a new scheme goes live.
 * Variables assumed: {{1}} = outletName, {{2}} = schemeName, {{3}} = acceptDeadline
 */
export async function notifySchemePublished(opts: {
  phone: string;
  outletName: string;
  schemeName: string;
  acceptDeadline: string;
  whatsappTemplateId: string;
  smsTemplateId?: string;
  smsMessage?: string;
}): Promise<{ channel: 'whatsapp' | 'sms' | 'none'; error?: string }> {
  const variables = {
    '{{1}}': opts.outletName,
    '{{2}}': opts.schemeName,
    '{{3}}': opts.acceptDeadline,
  };

  // Try WhatsApp first
  const waResult = await sendWhatsApp({
    phone: opts.phone,
    templateId: opts.whatsappTemplateId,
    variables,
  });

  if (waResult.success) return { channel: 'whatsapp' };

  // Fallback to SMS if provided
  if (opts.smsTemplateId && opts.smsMessage) {
    const smsResult = await sendSms({
      phone: opts.phone,
      templateId: opts.smsTemplateId,
      message: interpolateTemplate(opts.smsMessage, variables),
    });
    if (smsResult.success) return { channel: 'sms' };
    return { channel: 'none', error: smsResult.error };
  }

  return { channel: 'none', error: waResult.error };
}
