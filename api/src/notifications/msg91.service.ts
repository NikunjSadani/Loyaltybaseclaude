import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Shared MSG91 OTP provider. Sends OTPs synchronously via the MSG91 v5 OTP API.
 * Logic is byte-identical to the original AuthService.sendViaMSG91 — same dev
 * bypasses (FIXED_OTP, missing authKey) and the same "HTTP 200 + {type:'error'}"
 * failure check. Used by AuthService (login) and RewardsService (redemption OTP).
 */
@Injectable()
export class Msg91Service {
  private readonly logger = new Logger(Msg91Service.name);

  constructor(private readonly config: ConfigService) {}

  async sendOtp(phone: string, otp: string, channel: 'SMS' | 'WHATSAPP' = 'SMS'): Promise<void> {
    const authKey    = this.config.get<string>('MSG91_AUTH_KEY');
    const templateId = this.config.get<string>('MSG91_OTP_TEMPLATE_ID');
    const fixedOtp   = this.config.get<string>('FIXED_OTP');

    // FIXED_OTP mode — skip MSG91, log OTP to console (dev/staging only)
    // Production Cloud Run will never have FIXED_OTP set
    if (fixedOtp) {
      this.logger.warn(`[FIXED_OTP MODE] OTP for ${phone} is always: ${fixedOtp} — MSG91 not called`);
      return;
    }

    if (!authKey) {
      this.logger.warn(`[DEV] MSG91 not configured — OTP for ${phone}: ${otp}`);
      return;
    }

    // MSG91 OTP API v5 — authkey goes in the header, not the body.
    // Sender ID is configured on the template inside the MSG91 dashboard,
    // so it is NOT passed here. Both SMS and WhatsApp use the same endpoint;
    // routing is determined by the template type registered in MSG91.
    const url  = 'https://control.msg91.com/api/v5/otp';
    const body = { template_id: templateId, mobile: `91${phone}`, otp };

    const res = await fetch(url, {
      method:  'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    // MSG91 can return HTTP 200 with {"type":"error"} — check the body too
    const json = await res.json() as { type?: string; message?: string };
    if (!res.ok || json?.type === 'error') {
      const reason = json?.message ?? `HTTP ${res.status}`;
      this.logger.error(`MSG91 OTP failed for ${phone} (${channel}): ${reason}`);
      throw new Error(`Failed to send OTP via ${channel}: ${reason}`);
    }
  }
}
