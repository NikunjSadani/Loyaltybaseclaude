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
 *   - Product: GET {base}/v1/partners/products/:productId → { id, status, title,
 *             denominationType FIXED|FLEXIBLE, amountRestrictions{…} } (confirmed on
 *             staging 2026-11-11; an unknown/inactive id → HTTP 400 E102). See getProduct.
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

/**
 * A Hubble product (brand/SKU), normalised from GET /v1/partners/products/:productId.
 * CONFIRMED against staging (2026-11-11): the limits live under `amountRestrictions`
 * ({min,max}{Order,Voucher}Amount, maxVouchersPerOrder, denominations — null for FLEXIBLE).
 * Amounts are RUPEES. We always order ONE voucher, so the single-voucher bounds are the
 * tighter of the voucher and order limits, and FIXED denominations outside them are dropped.
 */
export interface HubbleProduct {
  productId: string;
  name: string;
  denominationType: 'FIXED' | 'FLEXIBLE';
  /**
   * FIXED: the issuable face values (rupees, ascending); [] for a FIXED brand means Hubble did
   * NOT return its list — treat as UNKNOWN (admin enters the amounts; Hubble validates).
   * FLEXIBLE: [].
   */
  denominations: number[];
  /** Smallest single-voucher value Hubble will issue (rupees). */
  minValue: number | null;
  /** Largest single-voucher value Hubble will issue (rupees). */
  maxValue: number | null;
  maxVouchersPerOrder: number | null;
}

/** Hubble credentials are not present in this environment. */
export class HubbleNotConfiguredError extends Error {
  constructor() {
    super('Hubble is not configured in this environment');
    this.name = 'HubbleNotConfiguredError';
  }
}

/** No such product on Hubble, or it is INACTIVE (vouchers cannot be generated). */
export class HubbleProductNotFoundError extends Error {
  constructor(productId: string, detail?: string) {
    super(`Hubble product ${productId} was not found or is not active${detail ? ` (${detail})` : ''}`);
    this.name = 'HubbleProductNotFoundError';
  }
}

@Injectable()
export class HubbleService {
  /** Product lookups are cached briefly — catalogue edits + issuance re-checks hit the same ids. */
  private readonly productCacheTtlMs = 10 * 60 * 1000;
  private readonly productCache = new Map<string, { product: HubbleProduct; expiresAt: number }>();

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

  /** Logged once per instance when only half of a credential pair is present. */
  private halfPairWarned = false;

  /**
   * Resolve the client id + secret as a PAIR — never one from each set. If EITHER environment-neutral
   * name (prod binds HUBBLE_CLIENT_ID / HUBBLE_CLIENT_SECRET) is set, the neutral pair is used; otherwise
   * the legacy `*_STAGING` pair (what staging binds), so staging keeps working unchanged. A blank value
   * counts as unset. A half-present pair resolves to "not configured" (manual-fulfilment fallback) and
   * logs a clear error naming the missing variable (never a value). Hubble credentials are PLATFORM-level
   * (one Hubble account); per-tenant enablement is the hubbleVoucherEnabled flag.
   */
  private creds(): { clientId?: string; clientSecret?: string } {
    const read = (k: string) => this.config.get<string>(k)?.trim() || undefined;
    const nId = read('HUBBLE_CLIENT_ID');
    const nSecret = read('HUBBLE_CLIENT_SECRET');
    const useNeutral = !!(nId || nSecret);
    const clientId = useNeutral ? nId : read('HUBBLE_CLIENT_ID_STAGING');
    const clientSecret = useNeutral ? nSecret : read('HUBBLE_CLIENT_SECRET_STAGING');
    if (!!clientId !== !!clientSecret && !this.halfPairWarned) {
      this.halfPairWarned = true;
      const suffix = useNeutral ? '' : '_STAGING';
      const missing = clientId ? `HUBBLE_CLIENT_SECRET${suffix}` : `HUBBLE_CLIENT_ID${suffix}`;
      this.logger.error(
        `Hubble credentials are half-configured: ${missing} is missing while its pair is set — Hubble is treated as NOT configured (manual fulfilment).`,
      );
    }
    return clientId && clientSecret ? { clientId, clientSecret } : {};
  }

  private clientId(): string | undefined {
    return this.creds().clientId;
  }

  private clientSecret(): string | undefined {
    return this.creds().clientSecret;
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

  /**
   * Fetch + normalise one product (brand). Read-only. Cached ~10 min per productId (only
   * successful ACTIVE lookups are cached). Throws HubbleNotConfiguredError (no creds),
   * HubbleProductNotFoundError (404 / 400 E102 "Brand is not active" / status INACTIVE /
   * malformed id), or a generic Error for anything else (5xx, timeout, unparseable body).
   */
  async getProduct(productId: string): Promise<HubbleProduct> {
    const id = (productId ?? '').trim();
    // Hubble ids are ULIDs; refuse anything that could alter the request path.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HubbleProductNotFoundError(id || '(blank)');
    if (!this.isConfigured()) throw new HubbleNotConfiguredError();

    const cached = this.productCache.get(id);
    if (cached && Date.now() < cached.expiresAt) return cached.product;

    const { status, json } = await this.authedFetch('GET', `/v1/partners/products/${encodeURIComponent(id)}`);
    const body = (json ?? {}) as Record<string, unknown>;
    if (status === 404) throw new HubbleProductNotFoundError(id);
    if (status === 400) {
      const code = String(body.id ?? '');
      const msg = String(body.message ?? '');
      if (code === 'E102' || /not active|not found/i.test(msg)) throw new HubbleProductNotFoundError(id, msg || code);
    }
    if (status < 200 || status >= 300) throw new Error(`Hubble getProduct HTTP ${status}`);

    const product = this.normaliseProduct(id, body);
    this.productCache.set(id, { product, expiresAt: Date.now() + this.productCacheTtlMs });
    return product;
  }

  private normaliseProduct(id: string, root: Record<string, unknown>): HubbleProduct {
    const data =
      root.data && typeof root.data === 'object' && !Array.isArray(root.data)
        ? (root.data as Record<string, unknown>)
        : root;
    if (String(data.status ?? 'ACTIVE').toUpperCase() !== 'ACTIVE') {
      throw new HubbleProductNotFoundError(id, 'INACTIVE');
    }
    const typeRaw = String(data.denominationType ?? '').toUpperCase();
    if (typeRaw !== 'FIXED' && typeRaw !== 'FLEXIBLE') {
      throw new Error(`Hubble product ${id} has an unknown denominationType "${typeRaw}"`);
    }
    const r = (data.amountRestrictions && typeof data.amountRestrictions === 'object'
      ? data.amountRestrictions
      : {}) as Record<string, unknown>;
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
    const minOf = (...v: (number | null)[]) => {
      const xs = v.filter((x): x is number => x != null);
      return xs.length ? Math.max(...xs) : null; // the TIGHTER lower bound
    };
    const maxOf = (...v: (number | null)[]) => {
      const xs = v.filter((x): x is number => x != null);
      return xs.length ? Math.min(...xs) : null; // the TIGHTER upper bound
    };
    const minValue = minOf(num(r.minVoucherAmount), num(r.minOrderAmount) ?? num(r.minAmount));
    const maxValue = maxOf(num(r.maxVoucherAmount), num(r.maxOrderAmount) ?? num(r.maxAmount));

    let denominations: number[] = [];
    if (typeRaw === 'FIXED') {
      // PRIMARY (confirmed shape): amountRestrictions.denominations = number[]. Tolerated
      // alternatives (the docs and live payloads disagree in places): numeric strings, objects
      // ({value|amount|denomination|faceValue}), and the list under data.denominations or
      // data.variantDetails. The first source that yields any value wins. An EMPTY result means
      // "Hubble didn't tell us" — callers treat it as UNKNOWN (never as "nothing issuable").
      const toAmount = (v: unknown): number | null => {
        if (typeof v === 'number') return num(v);
        if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) return num(Number(v));
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const o = v as Record<string, unknown>;
          for (const k of ['value', 'amount', 'denomination', 'faceValue', 'price']) {
            const a = toAmount(o[k]);
            if (a != null) return a;
          }
        }
        return null;
      };
      const sources = [r.denominations, data.denominations, data.variantDetails];
      for (const src of sources) {
        if (!Array.isArray(src)) continue;
        const parsed = [...new Set(
          src
            .map(toAmount)
            .filter((x): x is number => x != null && Number.isInteger(x))
            .filter((x) => (minValue == null || x >= minValue) && (maxValue == null || x <= maxValue)),
        )].sort((a, b) => a - b);
        if (parsed.length) {
          denominations = parsed;
          break;
        }
      }
    }
    const name = String(data.title ?? data.name ?? id);
    const maxV = r.maxVouchersPerOrder;
    return {
      productId: id,
      name,
      denominationType: typeRaw as 'FIXED' | 'FLEXIBLE',
      denominations,
      minValue,
      maxValue,
      maxVouchersPerOrder: typeof maxV === 'number' && Number.isFinite(maxV) ? maxV : null,
    };
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
