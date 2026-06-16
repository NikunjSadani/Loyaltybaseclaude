import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Wraps every successful controller return value in the platform's standard
 * success envelope: `{ success: true, data }`.
 *
 * This is the backend half of the contract that the web frontend's
 * `lib/api-client.ts` expects (`{ success: true, data }` / `{ success: false, error }`).
 * Controllers just return their data; the envelope is applied globally — the
 * Nest replacement for the per-route `ok()` helper in `lib/api-response.ts`.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, { success: true; data: T }> {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<{ success: true; data: T }> {
    return next.handle().pipe(map((data) => ({ success: true, data })));
  }
}
