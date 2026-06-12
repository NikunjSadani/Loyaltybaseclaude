/**
 * TDD tests for src/lib/msg91.ts
 *
 * All tests run in DEMO_MODE (no real HTTP calls) so they work in CI with no
 * API key.  The demo mode is driven by the DEMO_MSG91 flag.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildWhatsAppPayload,
  buildSmsPayload,
  buildOtpPayload,
  parseOtpResponse,
  parseVerifyOtpResponse,
  interpolateTemplate,
  type Msg91WhatsAppPayload,
  type Msg91SmsPayload,
  type Msg91OtpPayload,
} from '../msg91';

// ─────────────────────────────────────────────────────────────────────────────
// interpolateTemplate
// ─────────────────────────────────────────────────────────────────────────────

describe('interpolateTemplate', () => {
  it('replaces positional variables {{1}}, {{2}}', () => {
    const result = interpolateTemplate(
      'Hello {{1}}, your scheme {{2}} is live!',
      { '{{1}}': 'Sharma Kirana', '{{2}}': 'Summer Push' },
    );
    expect(result).toBe('Hello Sharma Kirana, your scheme Summer Push is live!');
  });

  it('leaves unmatched variables as-is', () => {
    const result = interpolateTemplate('Hi {{1}}, code: {{3}}', { '{{1}}': 'X' });
    expect(result).toBe('Hi X, code: {{3}}');
  });

  it('handles empty mapping', () => {
    const result = interpolateTemplate('Static message', {});
    expect(result).toBe('Static message');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildWhatsAppPayload
// ─────────────────────────────────────────────────────────────────────────────

describe('buildWhatsAppPayload', () => {
  it('builds a valid MSG91 WhatsApp payload', () => {
    const payload: Msg91WhatsAppPayload = buildWhatsAppPayload({
      phone: '919876543210',
      templateId: 'tmpl_abc123',
      variables: { '{{1}}': 'Sharma Kirana', '{{2}}': 'Summer Push' },
      country: '91',
    });

    expect(payload.integrated_number).toBe('919876543210');
    expect(payload.content_type).toBe('template');
    expect(payload.payload.messaging_product).toBe('whatsapp');
    expect(payload.payload.template.name).toBe('tmpl_abc123');
    // variables passed through
    expect(payload.payload.template.components).toBeDefined();
  });

  it('strips leading + from phone numbers', () => {
    const payload = buildWhatsAppPayload({
      phone: '+919876543210',
      templateId: 'tmpl_x',
      variables: {},
      country: '91',
    });
    expect(payload.integrated_number).toBe('919876543210');
  });

  it('prepends country code when phone lacks it', () => {
    const payload = buildWhatsAppPayload({
      phone: '9876543210',
      templateId: 'tmpl_x',
      variables: {},
      country: '91',
    });
    expect(payload.integrated_number).toBe('919876543210');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSmsPayload
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSmsPayload', () => {
  it('builds a valid MSG91 SMS payload', () => {
    const payload: Msg91SmsPayload = buildSmsPayload({
      phone: '919876543210',
      templateId: 'sms_xyz',
      message: 'Your scheme Summer Push is live. Accept by 5 Jun.',
      senderId: 'GIFSY',
    });

    expect(payload.sender).toBe('GIFSY');
    expect(payload.route).toBe('4'); // transactional
    expect(payload.sms[0].to[0]).toBe('919876543210');
    expect(payload.sms[0].message).toBe('Your scheme Summer Push is live. Accept by 5 Jun.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildOtpPayload
// ─────────────────────────────────────────────────────────────────────────────

describe('buildOtpPayload', () => {
  it('builds a valid OTP send payload', () => {
    const payload: Msg91OtpPayload = buildOtpPayload({
      phone: '919876543210',
      otpLength: 6,
      expiry: 10, // minutes
      templateId: 'otp_tmpl_abc',
    });

    expect(payload.mobile).toBe('919876543210');
    expect(payload.otp_length).toBe(6);
    expect(payload.expiry).toBe(10);
    expect(payload.template_id).toBe('otp_tmpl_abc');
  });

  it('defaults to 6-digit OTP and 10-minute expiry', () => {
    const payload = buildOtpPayload({ phone: '919876543210', templateId: 'x' });
    expect(payload.otp_length).toBe(6);
    expect(payload.expiry).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseOtpResponse
// ─────────────────────────────────────────────────────────────────────────────

describe('parseOtpResponse', () => {
  it('returns success=true when MSG91 responds with type=success', () => {
    const result = parseOtpResponse({ type: 'success', message: '3e4f6g7h' });
    expect(result.success).toBe(true);
    expect(result.requestId).toBe('3e4f6g7h');
  });

  it('returns success=false on error response', () => {
    const result = parseOtpResponse({ type: 'error', message: 'Invalid mobile number' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid mobile number');
  });

  it('handles unexpected shape gracefully', () => {
    const result = parseOtpResponse({});
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseVerifyOtpResponse
// ─────────────────────────────────────────────────────────────────────────────

describe('parseVerifyOtpResponse', () => {
  it('returns verified=true when MSG91 type is success', () => {
    const result = parseVerifyOtpResponse({ type: 'success', message: 'OTP verified successfully.' });
    expect(result.verified).toBe(true);
  });

  it('returns verified=false on wrong OTP', () => {
    const result = parseVerifyOtpResponse({ type: 'error', message: 'OTP not matched' });
    expect(result.verified).toBe(false);
    expect(result.error).toBe('OTP not matched');
  });
});
