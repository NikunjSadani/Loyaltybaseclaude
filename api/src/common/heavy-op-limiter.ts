import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';

/**
 * Per-instance heavy-operation limiter (memory-safety, 2026-11-13).
 *
 * Why: the API runs on Cloud Run with ~1 GiB and concurrency 80. A few operations
 * (Sales Import preview/apply/recalculate, target/achievement uploads, big exports,
 * points-compute previews) each hold 80–200 MB for tens of seconds. Two or three of
 * them overlapping on one instance exhausted the V8 heap and the crash failed EVERY
 * in-flight request on that instance. This semaphore caps how many of them run at
 * once per instance; extra callers get a clean 503 + `Retry-After` instead.
 *
 * Usage:
 *   - On a route: `@HeavyOp()` (applies {@link HeavyOpInterceptor}).
 *   - In code (e.g. a background job): `const release = heavyOpLimiter.tryAcquire('label');
 *     if (!release) throw heavyOpBusyException(); try { … } finally { release(); }`
 *
 * Release semantics (route form): the slot is released when the HTTP response is
 * finished OR the connection closes (client abort) — never when the handler's
 * observable completes, because a `StreamableFile` / piped response keeps streaming
 * (and holding memory) after the handler returns. A safety timer releases a slot that
 * is somehow never closed, so a leak cannot wedge the instance into permanent 503s.
 */

export const HEAVY_OP_MAX_CONCURRENT = 2;
export const HEAVY_OP_RETRY_AFTER_SECONDS = 30;
export const HEAVY_OP_BUSY_MESSAGE =
  'The server is busy with another large task. Please try again in a minute.';
/** A slot held longer than this is force-released (logged). Heavy ops finish in < 5 min. */
export const HEAVY_OP_SAFETY_RELEASE_MS = 15 * 60 * 1000;

export type HeavyOpRelease = () => void;

export class HeavyOpLimiter {
  private readonly logger = new Logger('HeavyOpLimiter');
  private active = 0;

  constructor(
    readonly maxConcurrent: number = HEAVY_OP_MAX_CONCURRENT,
    private readonly safetyReleaseMs: number = HEAVY_OP_SAFETY_RELEASE_MS,
  ) {}

  /** Slots currently held (for tests / diagnostics). */
  get inUse(): number {
    return this.active;
  }

  /**
   * Take a slot if one is free. Returns an idempotent `release` function, or `null`
   * when the instance is already running `maxConcurrent` heavy operations.
   */
  tryAcquire(label = 'heavy-op'): HeavyOpRelease | null {
    if (this.active >= this.maxConcurrent) {
      this.logger.warn(`Rejected heavy operation "${label}" — ${this.active}/${this.maxConcurrent} slots busy`);
      return null;
    }
    this.active += 1;
    let released = false;
    const timer = setTimeout(() => {
      if (!released) {
        this.logger.error(`Heavy operation "${label}" held a slot for > ${this.safetyReleaseMs} ms — force-releasing`);
        release();
      }
    }, this.safetyReleaseMs);
    // Never keep the process alive just for this timer.
    if (typeof timer.unref === 'function') timer.unref();

    const release: HeavyOpRelease = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      this.active = Math.max(0, this.active - 1);
    };
    return release;
  }

  /**
   * Run `fn` inside a slot (released in `finally`). Throws the 503 busy exception
   * when no slot is free. Use for non-streaming, in-process work (e.g. a job).
   */
  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const release = this.tryAcquire(label);
    if (!release) throw heavyOpBusyException();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Optional DI token for overriding the limiter (tests); unset in the app. */
export const HEAVY_OP_LIMITER = Symbol('HEAVY_OP_LIMITER');

/** The single per-instance limiter shared by every heavy route and job. */
export const heavyOpLimiter = new HeavyOpLimiter();

/**
 * Instant (light) export streams — their OWN small per-instance limit, separate from {@link heavyOpLimiter}, so a few
 * slow clients pulling small files can never block the heavy routes (uploads, Sales Import, …) behind them. A light
 * stream's memory is flat (streaming writer) — the cap only bounds concurrent DB paging. The stream itself also
 * aborts after EXPORT_INSTANT_IDLE_MS without progress (exports.service.ts), well before this safety release.
 */
export const INSTANT_EXPORT_MAX_CONCURRENT = 4;
export const INSTANT_EXPORT_SAFETY_RELEASE_MS = 10 * 60 * 1000;
export const instantExportLimiter = new HeavyOpLimiter(INSTANT_EXPORT_MAX_CONCURRENT, INSTANT_EXPORT_SAFETY_RELEASE_MS);

/** 503 with the standard busy message (the global filter renders `{ success:false, error }`). */
export function heavyOpBusyException(): HttpException {
  return new HttpException(HEAVY_OP_BUSY_MESSAGE, HttpStatus.SERVICE_UNAVAILABLE);
}

/**
 * Interceptor form. Acquires before the handler runs; releases on response
 * `finish` / `close` (covers normal completion, errors rendered by the exception
 * filter, streamed downloads, and client aborts).
 */
@Injectable()
export class HeavyOpInterceptor implements NestInterceptor {
  private readonly limiter: HeavyOpLimiter;

  // Nest instantiates this per route via DI: the token is never provided, so @Optional()
  // resolves `undefined` → the shared per-instance limiter. Tests pass their own limiter.
  constructor(@Optional() @Inject(HEAVY_OP_LIMITER) limiter?: HeavyOpLimiter) {
    this.limiter = limiter ?? heavyOpLimiter;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const label = `${req?.method ?? ''} ${req?.originalUrl ?? req?.url ?? context.getHandler()?.name ?? ''}`.trim();

    const release = this.limiter.tryAcquire(label);
    if (!release) {
      res?.setHeader?.('Retry-After', String(HEAVY_OP_RETRY_AFTER_SECONDS));
      throw heavyOpBusyException();
    }

    if (!res || typeof res.once !== 'function') {
      // No HTTP response object (should not happen for HTTP routes) — fall back to
      // releasing when the handler's observable settles.
      return new Observable((sub) => {
        const s = next.handle().subscribe({
          next: (v) => sub.next(v),
          error: (e) => { release(); sub.error(e); },
          complete: () => { release(); sub.complete(); },
        });
        return () => { release(); s.unsubscribe(); };
      });
    }

    // Already closed (client went away before we got here) → don't hold the slot.
    if (res.writableFinished || (res as { destroyed?: boolean }).destroyed) {
      release();
    } else {
      res.once('finish', release);
      res.once('close', release);
    }
    return next.handle();
  }
}

/** Route decorator: run this handler inside a heavy-operation slot. */
export function HeavyOp(): MethodDecorator & ClassDecorator {
  return applyDecorators(UseInterceptors(HeavyOpInterceptor));
}
