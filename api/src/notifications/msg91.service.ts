import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isFixedOtpAllowed } from '../common/fixed-otp';

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

  async sendOtp(
    phone: string,
    otp: string,
    channel: 'SMS' | 'WHATSAPP' = 'SMS',
    templateId?: string,
  ): Promise<void> {
    // `.trim()` defends against secrets saved with a leading UTF-8 BOM (U+FEFF) or
    // stray whitespace/newline — a BOM on MSG91_AUTH_KEY made `fetch` throw a
    // ByteString error ("character … value 65279") when set as the authkey header.
    const authKey    = this.config.get<string>('MSG91_AUTH_KEY')?.trim();
    // Per-tenant, per-purpose template override: use the caller-supplied templateId when
    // it's a non-empty string, else fall back to the global env template (prior behaviour,
    // so platform + unconfigured tenants are byte-identical to before).
    const override   = templateId?.trim();
    const resolvedTemplateId = override || this.config.get<string>('MSG91_OTP_TEMPLATE_ID')?.trim();
    // FIXED_OTP is a dev/staging convenience only, gated by isFixedOtpAllowed (non-prod
    // NODE_ENV, or an explicit ALLOW_FIXED_OTP opt-in; always refused on the prod DB). On
    // prod we fall through to the real MSG91 call so a stray env var can't suppress real SMS.
    const fixedOtp = isFixedOtpAllowed() ? this.config.get<string>('FIXED_OTP') : undefined;

    // FIXED_OTP mode — skip MSG91, log OTP to console (dev/staging only)
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
    const body = { template_id: resolvedTemplateId, mobile: `91${phone}`, otp };

    // Never hang the OTP request on an unresponsive MSG91 (e.g. egress/IP-whitelist issues):
    // a 10s timeout makes the send fail fast with a clear error instead of an endless spinner.
    let res: Response;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers: { authkey: authKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const reason = (e as Error)?.name === 'TimeoutError'
        ? 'MSG91 did not respond within 10s (timeout — check MSG91 IP whitelisting / egress)'
        : String(e);
      this.logger.error(`MSG91 OTP request failed for ${phone} (${channel}): ${reason}`);
      throw new Error(`Failed to send OTP via ${channel}: ${reason}`);
    }

    // MSG91 can return HTTP 200 with {"type":"error"} — check the body too
    const json = await res.json() as { type?: string; message?: string };
    if (!res.ok || json?.type === 'error') {
      const reason = json?.message ?? `HTTP ${res.status}`;
      this.logger.error(`MSG91 OTP failed for ${phone} (${channel}): ${reason}`);
      throw new Error(`Failed to send OTP via ${channel}: ${reason}`);
    }
  }

  /**
   * Send a WhatsApp TEMPLATE message via the MSG91 v5 bulk WhatsApp API.
   *
   * Mirrors sendOtp's conventions exactly:
   *   - authkey from MSG91_AUTH_KEY (.trim() — defends against a BOM/whitespace
   *     that would make `fetch` throw a ByteString error on the header).
   *   - DEV bypass: when no authKey is configured (non-prod without MSG91) we LOG
   *     and RETURN so a tenant without MSG91 wiring never errors. (Unlike sendOtp
   *     there is no FIXED_OTP analogue — a template message has no code to fake —
   *     so the only bypass is the missing-authKey one.)
   *   - 10s AbortSignal timeout → fail fast with a clear error, never an endless hang.
   *   - "HTTP 200 + {type:'error'}" body check → throw on the MSG91-reported failure.
   *
   * @param phone        the recipient's 10-digit mobile (country code is prepended → `91<phone>`)
   * @param templateName the MSG91-registered template name (e.g. 'deoleo_kyc_approval')
   * @param bodyValues   ordered body variables → mapped to body_1, body_2, … in template order
   */
  async sendWhatsappTemplate(
    phone: string,
    templateName: string,
    bodyValues: string[],
  ): Promise<void> {
    const authKey = this.config.get<string>('MSG91_AUTH_KEY')?.trim();
    // The integrated WhatsApp number registered with MSG91 for this platform.
    // Configurable via MSG91_WHATSAPP_NUMBER; defaults to the Deoleo-integrated number.
    const integratedNumber =
      this.config.get<string>('MSG91_WHATSAPP_NUMBER')?.trim() || '917003202293';

    // DEV bypass — same shape as sendOtp's missing-authKey path: a non-prod env
    // without MSG91 configured logs and returns instead of throwing.
    if (!authKey) {
      this.logger.warn(
        `[DEV] MSG91 not configured — WhatsApp template "${templateName}" for ${phone} not sent (values: ${JSON.stringify(bodyValues)})`,
      );
      return;
    }

    // Recipient sanity guard: the body prepends `91` (country code), so the caller
    // must pass a bare 10-digit mobile. A malformed value (already-prefixed, +91…,
    // non-numeric, legacy import) would double-prefix into an invalid WhatsApp number
    // — drop it with a log rather than send to a bad address. No-op, never throws.
    if (!/^\d{10}$/.test(phone)) {
      this.logger.warn(
        `WhatsApp template "${templateName}" skipped — recipient is not a bare 10-digit mobile.`,
      );
      return;
    }

    // MSG91 v5 bulk WhatsApp outbound — template message. The payload is built in
    // ONE place (below) for readability; field names mirror the MSG91 docs so the
    // orchestrator can runtime-verify / tweak against the real API in one spot.
    const url =
      'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
    const body = {
      integrated_number: integratedNumber,
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en', policy: 'deterministic' },
          to_and_components: [
            {
              to: [`91${phone}`],
              components: Object.fromEntries(
                bodyValues.map((value, i) => [
                  `body_${i + 1}`,
                  { type: 'text', value },
                ]),
              ),
            },
          ],
        },
      },
    };

    // Never hang the request on an unresponsive MSG91 — 10s timeout, then fail fast.
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authkey: authKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const reason =
        (e as Error)?.name === 'TimeoutError'
          ? 'MSG91 did not respond within 10s (timeout — check MSG91 IP whitelisting / egress)'
          : String(e);
      this.logger.error(
        `MSG91 WhatsApp template "${templateName}" request failed for ${phone}: ${reason}`,
      );
      throw new Error(`Failed to send WhatsApp template ${templateName}: ${reason}`);
    }

    // MSG91 can return HTTP 200 with {"type":"error"} — check the body too.
    const json = (await res.json()) as { type?: string; message?: string };
    if (!res.ok || json?.type === 'error') {
      const reason = json?.message ?? `HTTP ${res.status}`;
      this.logger.error(
        `MSG91 WhatsApp template "${templateName}" failed for ${phone}: ${reason}`,
      );
      throw new Error(`Failed to send WhatsApp template ${templateName}: ${reason}`);
    }
  }

  /**
   * Send a transactional EMAIL via the MSG91 v5 Email API. Used by the report
   * runner to deliver generated reports.
   *
   * Mirrors sendWhatsappTemplate's conventions exactly:
   *   - authkey from MSG91_AUTH_KEY (.trim() — defends against a BOM/whitespace
   *     that would make `fetch` throw a ByteString error on the header).
   *   - DEV bypass: when no authKey is configured we LOG and RETURN so a non-prod
   *     env without MSG91 wiring never errors (do NOT throw when unconfigured).
   *   - 10s AbortSignal timeout → fail fast with a clear error, never an endless hang.
   *   - "HTTP 200 + {type:'error'}" body check → throw on the MSG91-reported failure.
   *
   * On success logs a single info line. On failure THROWS — the caller (report
   * runner) catches it so one failed report doesn't block the others.
   *
   * @param params.to      recipient email addresses (no-op when empty)
   * @param params.subject the email subject line
   * @param params.html    the email body (HTML)
   */
  async sendEmail(params: { to: string[]; subject: string; html: string }): Promise<void> {
    const { to, subject, html } = params;

    // Nothing to send — no-op (never errors on an empty recipient list).
    if (to.length === 0) {
      return;
    }

    const authKey = this.config.get<string>('MSG91_AUTH_KEY')?.trim();

    // DEV bypass — same shape as sendWhatsappTemplate's missing-authKey path: a
    // non-prod env without MSG91 configured logs and returns instead of throwing.
    if (!authKey) {
      this.logger.warn(
        `[DEV] MSG91 not configured — email "${subject}" to ${to.join(', ')} skipped`,
      );
      return;
    }

    // The MSG91-verified sending address; the sending domain is the part after the @.
    const fromEmail =
      this.config.get<string>('REPORTS_FROM_EMAIL')?.trim() || 'reports@notify.gifsy.in';
    const domain = fromEmail.split('@')[1];

    // ⚠️ CONFIRM against MSG91 dashboard → API Integration tab before the first real
    // send — the exact field names of the v5 Email API aren't 100%-verified yet, so
    // the endpoint + payload construction are isolated in THIS one block for an easy
    // runtime-verify / tweak against the real API.
    const url = 'https://control.msg91.com/api/v5/email/send';
    const body = {
      recipients: to.map((email) => ({ to: [{ email }] })),
      from: { email: fromEmail },
      domain,
      subject,
      body: html,
    };
    // ── end MSG91 v5 Email payload block ─────────────────────────────────────────

    // Never hang the request on an unresponsive MSG91 — 10s timeout, then fail fast.
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authkey: authKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const reason =
        (e as Error)?.name === 'TimeoutError'
          ? 'MSG91 did not respond within 10s (timeout — check MSG91 IP whitelisting / egress)'
          : String(e);
      this.logger.error(`MSG91 email "${subject}" request failed: ${reason}`);
      throw new Error(`Failed to send email "${subject}": ${reason}`);
    }

    // MSG91 can return HTTP 200 with {"type":"error"} — check the body too.
    const json = (await res.json()) as { type?: string; message?: string };
    if (!res.ok || json?.type === 'error') {
      const reason = json?.message ?? `HTTP ${res.status}`;
      this.logger.error(`MSG91 email "${subject}" failed: ${reason}`);
      throw new Error(`Failed to send email "${subject}": ${reason}`);
    }

    this.logger.log(`Email "${subject}" sent to ${to.length} recipient(s)`);
  }
}
