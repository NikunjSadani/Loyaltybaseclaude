import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
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
   * @param opts         optional per-message extras:
   *   - `crqid`        a client reference id ECHOED back on the "On Outbound Report Received"
   *                    webhook → the correlation key the WhatsApp Broadcasts module uses to map
   *                    a status callback back to its recipient row. See the ⚠️ RUNTIME-VERIFY
   *                    note below on the exact field placement + response field name.
   *   - `languageCode` template language code (defaults to 'en'); a template registered in
   *                    another language must send its own code or MSG91 rejects the send.
   * @returns `{ requestId }` — MSG91's returned bulk request id (best-effort; null when the
   *   DEV bypass fires, the recipient is skipped, or the response carries no id). Existing
   *   callers (scheme broadcast) ignore the return value, so this is backward-compatible.
   */
  async sendWhatsappTemplate(
    phone: string,
    templateName: string,
    bodyValues: string[],
    opts?: { crqid?: string; languageCode?: string },
  ): Promise<{ requestId: string | null }> {
    const authKey = this.config.get<string>('MSG91_AUTH_KEY')?.trim();
    // The integrated WhatsApp number registered with MSG91 for this platform.
    // Configurable via MSG91_WHATSAPP_NUMBER; defaults to the Deoleo-integrated number.
    const integratedNumber =
      this.config.get<string>('MSG91_WHATSAPP_NUMBER')?.trim() || '917003202293';
    const languageCode = opts?.languageCode?.trim() || 'en';

    // DEV bypass — same shape as sendOtp's missing-authKey path: a non-prod env
    // without MSG91 configured logs and returns instead of throwing.
    if (!authKey) {
      this.logger.warn(
        `[DEV] MSG91 not configured — WhatsApp template "${templateName}" for ${phone} not sent (values: ${JSON.stringify(bodyValues)})`,
      );
      return { requestId: null };
    }

    // Recipient sanity guard: the body prepends `91` (country code), so the caller
    // must pass a bare 10-digit mobile. A malformed value (already-prefixed, +91…,
    // non-numeric, legacy import) would double-prefix into an invalid WhatsApp number
    // — drop it with a log rather than send to a bad address. No-op, never throws.
    if (!/^\d{10}$/.test(phone)) {
      this.logger.warn(
        `WhatsApp template "${templateName}" skipped — recipient is not a bare 10-digit mobile.`,
      );
      return { requestId: null };
    }

    // MSG91 v5 bulk WhatsApp outbound — template message. The payload is built in
    // ONE place (below) for readability; field names mirror the MSG91 docs so the
    // orchestrator can runtime-verify / tweak against the real API in one spot.
    //
    // ⚠️ RUNTIME-VERIFY (crqid): per the MSG91 v5 WhatsApp docs a client reference id
    // is carried on the per-recipient `to_and_components[]` entry as `crqid`, and is
    // echoed back on the "On Outbound Report Received" webhook. The exact key spelling
    // (`crqid`) + placement is per the current MSG91 docs — confirm against a real send +
    // a real webhook payload on staging. The Broadcasts webhook falls back to matching on
    // the returned requestId if the crqid echo differs, so a mismatch degrades gracefully.
    const to_and_component: Record<string, unknown> = {
      to: [`91${phone}`],
      components: Object.fromEntries(
        bodyValues.map((value, i) => [`body_${i + 1}`, { type: 'text', value }]),
      ),
    };
    if (opts?.crqid) to_and_component.crqid = opts.crqid;

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
          language: { code: languageCode, policy: 'deterministic' },
          to_and_components: [to_and_component],
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
    // ⚠️ RUNTIME-VERIFY (requestId): MSG91 returns the bulk request id in the response
    // body; the exact field name varies across docs (`request_id` / `requestId`, sometimes
    // nested under `data`). We read the common shapes and store whatever is present. This
    // is a best-effort correlation aid — the primary key is the crqid echoed on the webhook.
    const json = (await res.json()) as {
      type?: string;
      message?: string;
      request_id?: string;
      requestId?: string;
      data?: { request_id?: string; requestId?: string };
    };
    if (!res.ok || json?.type === 'error') {
      const reason = json?.message ?? `HTTP ${res.status}`;
      this.logger.error(
        `MSG91 WhatsApp template "${templateName}" failed for ${phone}: ${reason}`,
      );
      throw new Error(`Failed to send WhatsApp template ${templateName}: ${reason}`);
    }

    const requestId =
      json.request_id ??
      json.requestId ??
      json.data?.request_id ??
      json.data?.requestId ??
      null;
    return { requestId };
  }

  /**
   * Fallback status reconcile — query the MSG91 "status by requestID" API for a single
   * request id and return a coarse terminal/derived status. Used by the WhatsApp
   * Broadcasts fallback poll to catch recipients whose outbound-report webhook was
   * missed. FAIL-SAFE: never throws — returns `null` on any error / DEV-bypass / an
   * unrecognised body, so a reconcile pass can never crash the scheduler.
   *
   * ⚠️ RUNTIME-VERIFY: the MSG91 report/analytics-by-requestID endpoint URL + response
   * shape are per the current MSG91 v5 docs and MUST be confirmed against a real call on
   * staging. Implemented to the best-documented shape; wrong shape → null (no false
   * status flips), so this is safe to ship dormant behind the poll's gate.
   */
  async getWhatsappStatusByRequestId(
    requestId: string,
  ): Promise<{ status: string; raw: unknown } | null> {
    const authKey = this.config.get<string>('MSG91_AUTH_KEY')?.trim();
    if (!authKey || !requestId) return null;

    const base =
      this.config.get<string>('MSG91_WHATSAPP_REPORT_URL')?.trim() ||
      'https://control.msg91.com/api/v5/whatsapp/report/';
    const url = `${base}${encodeURIComponent(requestId)}`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { authkey: authKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        type?: string;
        status?: string;
        data?: { status?: string };
      };
      if (json?.type === 'error') return null;
      const status = json.status ?? json.data?.status;
      if (typeof status !== 'string' || status.trim() === '') return null;
      return { status, raw: json };
    } catch (e) {
      this.logger.warn(
        `MSG91 WhatsApp status-by-requestId reconcile failed for ${requestId}: ${e}`,
      );
      return null;
    }
  }

  /**
   * Send a transactional SMS via the MSG91 v5 FLOW API (DLT-registered template).
   *
   * Mirrors sendOtp's conventions EXACTLY:
   *   - authkey from MSG91_AUTH_KEY (.trim() — defends against a BOM/whitespace that
   *     would make `fetch` throw a ByteString error when set as the header).
   *   - DEV bypass: when no authKey is configured (non-prod without MSG91) we LOG and
   *     RETURN so a tenant without MSG91 wiring never errors. (There is no FIXED_OTP
   *     analogue — a transactional SMS has no code to fake — so the missing-authKey
   *     bypass is the only one.)
   *   - 10s AbortSignal timeout → fail fast with a clear error, never an endless hang.
   *   - "HTTP 200 + {type:'error'}" body check → throw on the MSG91-reported failure.
   *   - Bare-10-digit recipient guard (mirrors sendWhatsappTemplate): the body prepends
   *     `91`, so a malformed number is dropped with a log rather than double-prefixed.
   *
   * MSG91 v5 FLOW request shape (control.msg91.com/api/v5/flow/):
   *   body { template_id, recipients: [{ mobiles: '91'+phone, <VAR>: <value>, … }] }
   * The per-recipient object carries `mobiles` plus the DLT template's NAMED variables
   * (spread from `variables`). ⚠️ RUNTIME-VERIFY the exact variable KEY NAMES against the
   * DLT template registered in MSG91 — they must match the template's `##VAR##` names.
   *
   * @param phone     recipient's bare 10-digit mobile (country code prepended → `91<phone>`)
   * @param templateId the MSG91 flow/DLT template id
   * @param variables the template's named variables → spread into the recipient object
   */
  async sendSms(
    phone: string,
    templateId: string,
    variables: Record<string, string> = {},
  ): Promise<void> {
    const authKey = this.config.get<string>('MSG91_AUTH_KEY')?.trim();

    // DEV bypass — same shape as sendOtp's missing-authKey path: a non-prod env without
    // MSG91 configured logs and returns instead of throwing.
    if (!authKey) {
      this.logger.warn(
        `[DEV] MSG91 not configured — SMS template "${templateId}" for ${phone} not sent (vars: ${JSON.stringify(variables)})`,
      );
      return;
    }

    // Recipient sanity guard (mirrors sendWhatsappTemplate): the body prepends `91`, so a
    // malformed value (already-prefixed, +91…, non-numeric, legacy import) would become an
    // invalid number — drop it with a log rather than send to a bad address. No-op, no throw.
    if (!/^\d{10}$/.test(phone)) {
      this.logger.warn(
        `SMS template "${templateId}" skipped — recipient is not a bare 10-digit mobile.`,
      );
      return;
    }

    // MSG91 v5 flow API — authkey in the header (never the body), template_id + recipients
    // in the body. Each recipient carries `mobiles` plus the template's named variables.
    const url = 'https://control.msg91.com/api/v5/flow/';
    const body = {
      template_id: templateId,
      recipients: [{ mobiles: `91${phone}`, ...variables }],
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
      this.logger.error(`MSG91 SMS template "${templateId}" request failed for ${phone}: ${reason}`);
      throw new Error(`Failed to send SMS template ${templateId}: ${reason}`);
    }

    // MSG91 can return HTTP 200 with {"type":"error"} — check the body too.
    const json = (await res.json()) as { type?: string; message?: string };
    if (!res.ok || json?.type === 'error') {
      const reason = json?.message ?? `HTTP ${res.status}`;
      this.logger.error(`MSG91 SMS template "${templateId}" failed for ${phone}: ${reason}`);
      throw new Error(`Failed to send SMS template ${templateId}: ${reason}`);
    }
  }

  /**
   * Send a transactional EMAIL via the MSG91 SMTP RELAY (Domain Settings → SMTP
   * Integration), using nodemailer. Used by the report runner to deliver generated
   * report HTML. NOT the MSG91 v5 email HTTP API — that path is TEMPLATE-only
   * (template_id + short variables) and can't carry our rich, dynamic-length report
   * tables; SMTP accepts the full rendered HTML unchanged.
   *
   * Conventions:
   *   - Credential = the MSG91_SMTP_PASS secret. Host/port/user default to MSG91's
   *     relay for the verified `notify.gifsy.in` domain (smtp.mailer91.com:587,
   *     emailer@notify.gifsy.in) and are env-overridable; from = REPORTS_FROM_EMAIL.
   *   - requireTLS (STARTTLS) on 587 so the password can never be sent in cleartext.
   *   - DEV bypass: when MSG91_SMTP_PASS is unset we LOG and RETURN so a non-prod env
   *     without SMTP wiring never errors (do NOT throw when unconfigured).
   *   - Bounded connection/greeting/socket timeouts → fail fast, never an endless hang.
   *
   * On success logs a single info line. On failure THROWS — the caller (report
   * runner) catches it so one failed report doesn't block the others. The password
   * is never logged.
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

    // MSG91 email sends over SMTP relay (Domain Settings → SMTP Integration), NOT the v5
    // HTTP API: the v5 API is TEMPLATE-based (template_id + short variables) and can't carry
    // our rich, dynamic-length report HTML. SMTP accepts the full rendered HTML unchanged.
    // Auth = the SMTP password (secret); host/port/user default to MSG91's relay for the
    // verified `notify.gifsy.in` domain and are env-overridable.
    const pass = this.config.get<string>('MSG91_SMTP_PASS')?.trim();

    // DEV bypass — mirrors the OTP path's missing-credential behavior: a non-prod env
    // without SMTP configured logs and returns instead of throwing (so local/CI never send).
    if (!pass) {
      this.logger.warn(
        `[DEV] MSG91 SMTP not configured — email "${subject}" to ${to.join(', ')} skipped`,
      );
      return;
    }

    const host = this.config.get<string>('MSG91_SMTP_HOST')?.trim() || 'smtp.mailer91.com';
    const port = Number(this.config.get<string>('MSG91_SMTP_PORT')?.trim() || '587');
    const user = this.config.get<string>('MSG91_SMTP_USER')?.trim() || 'emailer@notify.gifsy.in';
    // The from-address must be on the MSG91-verified sending domain (notify.gifsy.in).
    const from =
      this.config.get<string>('REPORTS_FROM_EMAIL')?.trim() || 'reports@notify.gifsy.in';

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 = implicit TLS
      // 587 = STARTTLS: require it (not opportunistic) so the SMTP password can NEVER be sent
      // in cleartext if the relay/path fails to advertise STARTTLS — fail the send instead.
      requireTLS: port !== 465,
      auth: { user, pass },
      // Never hang the pipeline on an unresponsive relay — bound every phase.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });

    try {
      const info = await transporter.sendMail({ from, to, subject, html });
      this.logger.log(
        `Email "${subject}" sent to ${to.length} recipient(s) via SMTP (id ${info.messageId})`,
      );
    } catch (e) {
      const reason = (e as Error)?.message ?? String(e);
      this.logger.error(`MSG91 SMTP email "${subject}" failed: ${reason}`);
      throw new Error(`Failed to send email "${subject}": ${reason}`);
    } finally {
      transporter.close();
    }
  }
}
