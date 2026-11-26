import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
  SetMetadata,
  StreamableFile,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { neutralFulfillerDeep } from '../fulfiller-name';

/** Route metadata: also neutralise object KEYS naming the fulfiller (see NeutralFulfillerKeys). */
export const NEUTRAL_FULFILLER_KEYS = 'neutralFulfillerKeys';

/**
 * Mark a handler / controller whose response must carry NO trace of the voucher fulfiller's name for a
 * non-Gifsy caller — keys included (hubbleNeedsReconcile → apiNeedsReconcile). Use it only on READ
 * responses the client never writes back key-for-key (order lists / detail / tracking / redeem results);
 * an editable shape (e.g. a catalogue item's metadata.hubbleProductId) must keep its keys.
 */
export const NeutralFulfillerKeys = () => SetMetadata(NEUTRAL_FULFILLER_KEYS, true);

/** Gifsy platform operators — the only callers who may see the fulfiller's real name on screen. */
const GIFSY_ROLES: ReadonlySet<string> = new Set(['GIFSY_ADMIN', 'GIFSY_STAFF']);

/** True when the request is NOT from a Gifsy operator (client admin / user, sales, partner, vendor, anonymous). */
export function isNonGifsyRequest(req: { user?: { role?: string | null } } | undefined): boolean {
  return !GIFSY_ROLES.has(req?.user?.role ?? '');
}

/**
 * Wraps every successful controller return value in the platform's standard
 * success envelope: `{ success: true, data }`.
 *
 * This is the backend half of the contract that the web frontend's
 * `lib/api-client.ts` expects (`{ success: true, data }` / `{ success: false, error }`).
 * Controllers just return their data; the envelope is applied globally — the
 * Nest replacement for the per-route `ok()` helper in `lib/api-response.ts`.
 *
 * Exception: binary/file responses (`StreamableFile` — used for xlsx/report/
 * payout-file downloads) are passed through UNWRAPPED, so the download isn't
 * corrupted by the JSON envelope.
 *
 * OWNER RULE (2026-11-26, all clients): for every NON-Gifsy caller, every string value naming the voucher
 * fulfiller ("Hubble") is presented as "Via API" / neutral words (stored values are never changed); routes
 * marked @NeutralFulfillerKeys() get their object keys neutralised too. Gifsy operators get the raw data.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, unknown> {
  constructor(@Optional() private readonly reflector?: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.getType() === 'http' ? ctx.switchToHttp().getRequest() : undefined;
    return next.handle().pipe(
      map((data) => {
        if (data instanceof StreamableFile) return data;
        if (!req || !isNonGifsyRequest(req)) return { success: true, data };
        const keys =
          this.reflector?.getAllAndOverride<boolean>(NEUTRAL_FULFILLER_KEYS, [ctx.getHandler(), ctx.getClass()]) === true;
        return { success: true, data: neutralFulfillerDeep(data, { keys }) };
      }),
    );
  }
}
