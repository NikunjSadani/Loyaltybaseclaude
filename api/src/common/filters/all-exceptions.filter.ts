import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { neutralFulfillerDeep, neutralFulfillerText } from '../fulfiller-name';
import { isNonGifsyRequest } from '../interceptors/transform.interceptor';

/**
 * Formats every thrown exception as the platform's standard error envelope:
 * `{ success: false, error }` with the correct HTTP status.
 *
 * The Nest replacement for the per-route `err()` helper in `lib/api-response.ts`.
 * Controllers/services just `throw new BadRequestException('...')` (etc.) and the
 * shape the frontend's `api-client.ts` expects is produced here, globally.
 *
 * - `HttpException` → its status + message (class-validator arrays are joined).
 * - Anything else  → 500 + a generic message (real error logged, not leaked).
 * - OWNER RULE (2026-11-26): a NON-Gifsy caller never reads the voucher fulfiller's name ("Hubble") in an
 *   error — it is presented as "Via API" / neutral words (Gifsy operators get the message unchanged).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal server error';
    // Opt-in machine-readable extras: ONLY an exception thrown with `{ message, details: {...} }` carries them
    // (e.g. the credits confirm's missingAcknowledgements). Every other exception's envelope is unchanged.
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        error = body;
      } else {
        // Nest/class-validator shape: { statusCode, message, error }
        const msg = (body as { message?: string | string[]; error?: string }).message;
        error = Array.isArray(msg) ? msg.join(', ') : (msg ?? (body as { error?: string }).error ?? 'Error');
        const d = (body as { details?: unknown }).details;
        if (d && typeof d === 'object' && !Array.isArray(d)) details = d as Record<string, unknown>;
      }
    } else {
      // Unexpected error — log the real thing, return a safe generic message.
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    const http = host.switchToHttp();
    const req = typeof http.getRequest === 'function'
      ? http.getRequest<Request & { user?: { role?: string | null } }>()
      : undefined;
    if (isNonGifsyRequest(req)) {
      error = neutralFulfillerText(error);
      if (details) details = neutralFulfillerDeep(details);
    }

    res.status(status).json(details ? { success: false, error, details } : { success: false, error });
  }
}
