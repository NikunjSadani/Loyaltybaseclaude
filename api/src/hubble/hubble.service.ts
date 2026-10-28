import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

/**
 * Hubble Money integration — the thin HTTP client for the vendor's Partner API.
 *
 * Scope (Bajaj-only, flag-gated — see RewardsService): place an Amazon Pay voucher
 * order on CONFIRM of a GIFT_CARD redemption, and recover/poll its state by our
 * referenceId. This service is a PURE API adapter: NO business logic, NO DB, NO
 * wallet. The money-safety (debit → issue → refund-on-fail, idempotency) lives in
 * RewardsService which composes this.
 *
 * CONFIRMED contract (built to the owner-supplied spec):
 *   - Auth:   POST {base}/v1/partners/auth/login {clientId, clientSecret}
 *             → { token, expiresInSecs (~3600) }. Token cached in-memory, refreshed
 *             at ~80% of life; a 401 on any call forces ONE re-auth + retry.
 *   - Order:  POST {base}/v1/partners/orders → ALWAYS HTTP 201; branch on BODY.status
 *             (SUCCESS | PROCESSING | FAILED). referenceId = our idempotency key.
 *   - Status: GET  {base}/v1/partners/orders/by-reference/:referenceId (recovery).
 *
 * Secrets are read from config and NEVER logged (no token, clientSecret, or card
 * data ever reaches a log line). Every call is bounded by a timeout so a hung Hubble
 * can't wedge a redemption request.
 */

/** cardType values Hubble returns on a delivered voucher. */
export type HubbleCardType =
  | 'CARD_NUMBER_SECURED'
  | 'PIN_NO_SECURED'
  | 'CARD_AND_PIN_NO_SECURED';

export interface HubbleVoucher {
  id?: string;
  cardType?: HubbleCardType | string;
  cardPin?: string | null;
  cardNumber?: string | null;
  validTill?: string | null;
  amount?: number | null;
}

/** The three terminal/intermediate order states Hubble reports in the body. */
export type HubbleOrderStatus = 'SUCCESS' | 'PROCESSING' | 'FAILED' | string;

export interface HubbleOrderResult {
  /** Hubble's own order id (distinct from our referenceId). */
  id?: string;
  orderId?: string;
  referenceId?: string;
  status: HubbleOrderStatus;
  vouchers?: HubbleVoucher[];
  failureReason?: string | null;
  /** The raw body, kept for diagnostics / metadata persistence (card data stripped by caller). */
  raw?: unknown;
}

export interface PlaceOrderParams {
  productId: string;
  /** Our idempotency key — the RedemptionOrder id (≤40 chars, globally unique). */
  referenceId: string;
  /** Order value in RUPEES (= Σ denomination×quantity). */
  amount: number;
  denominationDetails: { denomination: number; quantity: number }[];
  /** null for B2B (our case). */
  customerDetails?: unknown | null;
}

@Injectable()
export class HubbleService {
  private readonly logger = new Logger(HubbleService.name);

  /** In-memory token cache. Per Cloud Run instance; a cold instance re-auths once. */
  private tokenCache: { token: string; expiresAt: number } | null = null;

  /** Serialise concurrent logins so a burst of confirms triggers ONE auth call. */
  private loginInFlight: Promise<string> | null = null;

  private readonly requestTimeoutMs = 15_000;

  constructor(private readonly config: ConfigService) {}

  /** Base URL (no trailing slash). Staging default documented in deploy workflow. */
  private baseUrl(): string {
    const raw = this.config.get<string>('HUBBLE_BASE_URL')?.trim();
    return (raw || 'https://api.dev.myhubble.money').replace(/\/+$/, '');
  }

  private clientId(): string | undefined {
    // TODO(prod): resolve prod creds (HUBBLE_CLIENT_ID / _PROD) once prod onboarding
    // is done. Staging is wired now; prod secrets are a later, deliberate step.
    return this.config.get<string>('HUBBLE_CLIENT_ID_STAGING')?.trim();
  }

  private clientSecret(): string | undefined {
    return this.config.get<string>('HUBBLE_CLIENT_SECRET_STAGING')?.trim();
  }

  /**
   * True iff Hubble is wired in this environment (base URL always has a default;
   * creds must be present). The caller (RewardsService) gates on this so a flag-ON
   * tenant on an un-provisioned environment degrades to the manual fulfilment path
   * rather than refunding/erroring every redemption.
   */
  isConfigured(): boolean {
    return !!this.clientId() && !!this.clientSecret();
  }

  /** Force the next call to re-authenticate (used after a 401). */
  private invalidateToken(): void {
    this.tokenCache = null;
  }

  /**
   * Return a valid bearer token, logging in (and caching) when needed. Refreshes at
   * ~80% of the stated lifetime so a token never expires mid-request. Concurrent
   * callers share a single in-flight login.
   */
  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && now < this.tokenCache.expiresAt) {
      return this.tokenCache.token;
    }
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async login(): Promise<string> {
    const clientId = this.clientId();
    const clientSecret = this.clientSecret();
    if (!clientId || !clientSecret) {
      throw new Error('Hubble is not configured (missing client credentials)');
    }

    const res = await this.rawFetch(`${this.baseUrl()}/v1/partners/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });

    const json = (await this.safeJson(res)) as {
      token?: string;
      expiresInSecs?: number;
    } | null;

    if (!res.ok || !json?.token) {
      // NEVER echo the body — it may reflect the credentials. Status only.
      throw new Error(`Hubble auth failed (HTTP ${res.status})`);
    }

    const lifeSecs = typeof json.expiresInSecs === 'number' && json.expiresInSecs > 0
      ? json.expiresInSecs
      : 3600;
    // Refresh at 80% of life; floor the skew so a tiny lifetime still caches briefly.
    const ttlMs = Math.max(30_000, Math.floor(lifeSecs * 0.8 * 1000));
    this.tokenCache = { token: json.token, expiresAt: Date.now() + ttlMs };
    this.logger.log(`Hubble auth ok (token cached ~${Math.round(ttlMs / 1000)}s)`);
    return json.token;
  }

  /**
   * Authenticated JSON call with ONE automatic 401 re-auth + retry. Returns the
   * parsed body plus the HTTP status so the caller can distinguish 404 (recovery
   * miss) from a real body.
   */
  private async authedFetch(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const doCall = async (token: string): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'X-REQUEST-ID': randomUUID(),
        'Content-Type': 'application/json',
      };
      return this.rawFetch(`${this.baseUrl()}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    };

    let token = await this.getToken();
    let res = await doCall(token);

    if (res.status === 401) {
      // Token may have been revoked/expired early — re-auth ONCE and retry.
      this.invalidateToken();
      token = await this.getToken();
      res = await doCall(token);
    }

    const json = await this.safeJson(res);
    return { status: res.status, json };
  }

  /**
   * Place an order. Hubble returns HTTP 201 ALWAYS; the caller branches on the BODY
   * `status` (SUCCESS / PROCESSING / FAILED). A non-2xx (auth/validation/5xx) THROWS
   * so the caller's recover-by-reference path runs.
   */
  async placeOrder(params: PlaceOrderParams): Promise<HubbleOrderResult> {
    const { status, json } = await this.authedFetch('POST', '/v1/partners/orders', {
      productId: params.productId,
      referenceId: params.referenceId,
      amount: params.amount,
      denominationDetails: params.denominationDetails,
      customerDetails: params.customerDetails ?? null,
    });

    if (status < 200 || status >= 300) {
      throw new Error(`Hubble placeOrder non-success HTTP ${status}`);
    }
    return this.normaliseOrderBody(json);
  }

  /**
   * Recover/poll an order by OUR referenceId. Returns null on a 404 (Hubble has no
   * such order — definitively never placed), the parsed result otherwise. A non-404
   * error status THROWS (indeterminate — the caller must not assume "not placed").
   */
  async getOrderByReference(referenceId: string): Promise<HubbleOrderResult | null> {
    const { status, json } = await this.authedFetch(
      'GET',
      `/v1/partners/orders/by-reference/${encodeURIComponent(referenceId)}`,
    );
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      throw new Error(`Hubble getOrderByReference HTTP ${status}`);
    }
    return this.normaliseOrderBody(json);
  }

  /** Normalise the (possibly nested under `data`) order body into HubbleOrderResult. */
  private normaliseOrderBody(json: unknown): HubbleOrderResult {
    const root = (json ?? {}) as Record<string, unknown>;
    const data =
      root.data && typeof root.data === 'object'
        ? (root.data as Record<string, unknown>)
        : root;
    const statusRaw = (data.status ?? root.status) as string | undefined;
    return {
      id: (data.id ?? data.orderId) as string | undefined,
      orderId: data.orderId as string | undefined,
      referenceId: data.referenceId as string | undefined,
      status: (statusRaw ?? 'PROCESSING') as HubbleOrderStatus,
      vouchers: Array.isArray(data.vouchers)
        ? (data.vouchers as HubbleVoucher[])
        : [],
      failureReason:
        (data.failureReason as string | undefined) ??
        (root.failureReason as string | undefined) ??
        null,
      raw: json,
    };
  }

  /** fetch with a bounded timeout; translates an abort into a clear error. */
  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      const reason =
        (e as Error)?.name === 'TimeoutError'
          ? `Hubble did not respond within ${this.requestTimeoutMs / 1000}s`
          : String((e as Error)?.message ?? e);
      // URL path only (no headers/body) — never risk leaking the token/secret.
      this.logger.error(`Hubble request failed: ${reason}`);
      throw new Error(`Hubble request failed: ${reason}`);
    }
  }

  /** Parse a JSON body defensively (an empty/non-JSON body → null, never throws). */
  private async safeJson(res: Response): Promise<unknown> {
    try {
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}
