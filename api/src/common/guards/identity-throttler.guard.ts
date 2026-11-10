import { ExecutionContext, Injectable, Logger, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { ExtractJwt } from 'passport-jwt';
import { createHash } from 'node:crypto';

/** Route metadata: which request identity the throttle bucket is keyed on (default: user/IP). */
export const THROTTLE_KEY_BY = 'throttle:keyBy';

/**
 * Key this route's throttle bucket on the (normalised) `phone` in the request body instead of the
 * caller. For PRE-AUTH OTP endpoints only — there is no user yet, and the IP is not a usable identity
 * (every login arrives through the Next server action / proxy, so `req.ip` is effectively one value).
 */
export const ThrottleByPhone = () => SetMetadata(THROTTLE_KEY_BY, 'phone');

/** Per-request log label for the tracker (never the raw phone). Not part of the bucket key. */
const LOG_LABEL = Symbol('throttleLogLabel');

type Req = {
  ip?: string;
  method?: string;
  baseUrl?: string;
  route?: { path?: string };
  body?: unknown;
  headers?: Record<string, unknown>;
  [LOG_LABEL]?: string;
};

/**
 * Global throttler keyed on the caller's IDENTITY rather than `req.ip` (2026-11-10 fix).
 *
 *  - `@ThrottleByPhone()` routes (POST /v1/auth/send-otp, /verify-otp) → `phone:<sha256(10 digits)>`
 *    from the request body. The phone ALONE (not clientId:phone): OtpCode rows and the DB send cap
 *    are phone-keyed, so mixing in a caller-supplied clientId would let an attacker rotate it to buy
 *    fresh buckets for one victim number. Absent/malformed → IP fallback (never throws).
 *  - any non-@Public route with a valid access token → `user:<sub>`. The token is checked with the
 *    SAME extraction (Authorization: Bearer) and secret/expiry rules as JwtStrategy. This guard only
 *    computes a key; JwtAuthGuard (which runs after it) still decides the auth outcome.
 *  - everything else → `ip:<req.ip>` (unchanged behaviour).
 *
 * Limits, @Throttle overrides, @SkipThrottle and the module-level skipIf are untouched — the stock
 * ThrottlerGuard still does all of that; only getTracker (and the 429 log line) is overridden.
 * Buckets stay per-route (the stock generateKey hashes class+handler+throttler+tracker) and in-memory
 * per instance; the DB per-phone send cap in AuthService.sendOtp remains the cross-instance backstop.
 */
@Injectable()
export class IdentityThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger('Throttle');
  private readonly jwt: JwtService | null;
  private readonly extractBearer = ExtractJwt.fromAuthHeaderAsBearerToken();

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    config: ConfigService,
  ) {
    super(options, storageService, reflector);
    // Same secret source as JwtStrategy (ConfigService JWT_SECRET; the app refuses to boot without it).
    const secret = config.get<string>('JWT_SECRET');
    this.jwt = secret ? new JwtService({ secret }) : null;
  }

  protected async getTracker(req: Record<string, any>, context?: ExecutionContext): Promise<string> {
    const r = req as Req;
    const resolved = context ? this.resolveIdentity(r, context) : null;
    const { tracker, label } = resolved ?? this.ipIdentity(r);
    r[LOG_LABEL] = label;
    return tracker;
  }

  private resolveIdentity(req: Req, context: ExecutionContext): { tracker: string; label: string } {
    const targets = [context.getHandler(), context.getClass()];
    const keyBy = this.reflector.getAllAndOverride<string>(THROTTLE_KEY_BY, targets);
    if (keyBy === 'phone') {
      const digits = normalisePhone(req.body);
      if (digits) {
        return {
          tracker: `phone:${createHash('sha256').update(digits).digest('hex')}`,
          label:   `phone:******${digits.slice(-4)}`,
        };
      }
      return this.ipIdentity(req);
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', targets);
    if (!isPublic) {
      const sub = this.verifiedSubject(req);
      if (sub) return { tracker: `user:${sub}`, label: `user:${sub}` };
    }
    return this.ipIdentity(req);
  }

  private ipIdentity(req: Req): { tracker: string; label: string } {
    const key = `ip:${req.ip ?? 'unknown'}`;
    return { tracker: key, label: key };
  }

  /** `sub` of a token that passes JwtStrategy's signature + expiry checks, else null. Never throws. */
  private verifiedSubject(req: Req): string | null {
    if (!this.jwt) return null;
    try {
      const token = this.extractBearer(req as never);
      if (!token) return null;
      const payload = this.jwt.verify<{ sub?: unknown }>(token);
      return typeof payload?.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
    } catch {
      return null;
    }
  }

  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const req = context.switchToHttp().getRequest<Req>();
    const label = req?.[LOG_LABEL] ?? 'unknown';
    // Structured, distinct from AuthService's "[otp-send-cap]" (the DB per-phone cap) line.
    this.logger.warn(
      `throttle.rejected ${JSON.stringify({
        event:   'throttle.rejected',
        route:   `${req?.method ?? '?'} ${req?.baseUrl ?? ''}${req?.route?.path ?? ''}`,
        handler: `${context.getClass().name}.${context.getHandler().name}`,
        keyKind: label.split(':')[0],
        key:     label,
        limit:   detail.limit,
        ttlMs:   detail.ttl,
        hits:    detail.totalHits,
      })}`,
    );
    return super.throwThrottlingException(context, detail);
  }
}

/** The 10 digits AuthService.sendOtp/verifyOtp would use (`phone.replace(/\D/g, '')`), or null. */
function normalisePhone(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const phone = (body as { phone?: unknown }).phone;
  if (typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
}
