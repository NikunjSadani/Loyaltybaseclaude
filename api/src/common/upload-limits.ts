import {
  CallHandler,
  ExecutionContext,
  Injectable,
  mixin,
  NestInterceptor,
  PayloadTooLargeException,
  Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { Observable } from 'rxjs';

/**
 * Upload size ceilings enforced BY MULTER (memory-safety, 2026-11-13).
 *
 * multer's memoryStorage buffers the whole multipart body before the handler runs, so a
 * size check inside the service (`if (file.size > 5 MB)`) comes too late — a 30 MB body
 * has already been held in RAM. Every single-file upload now goes through
 * {@link LimitedFileInterceptor}, which sets `limits.fileSize` so multer aborts the
 * upload as soon as the limit is crossed, and answers 413 with a clear message.
 */

const MiB = 1024 * 1024;

/** Photos / KYC documents / cheque scans — the size the services already enforced after the fact. */
export const MEDIA_UPLOAD_MAX_BYTES = 5 * MiB;
/** Spreadsheet uploads (targets, achievements, TDS, UTR, bulk-verify, …). */
export const SPREADSHEET_UPLOAD_MAX_BYTES = 10 * MiB;

export function fileTooLargeMessage(maxBytes: number): string {
  const mb = maxBytes / MiB;
  const label = Number.isInteger(mb) ? String(mb) : mb.toFixed(1);
  return `The file is too large — the limit is ${label} MB. Please upload a smaller file.`;
}

/**
 * `FileInterceptor(field, …)` with a mandatory multer `limits.fileSize` and a clear 413.
 * Any other multer options (e.g. `fileFilter`) pass straight through.
 */
export function LimitedFileInterceptor(
  fieldName: string,
  maxBytes: number,
  options: MulterOptions = {},
): Type<NestInterceptor> {
  const Inner = FileInterceptor(fieldName, {
    ...options,
    // busboy flags the limit when the byte count REACHES `fileSize`, so a file of exactly
    // `maxBytes` would be rejected; +1 keeps "≤ maxBytes is allowed" (as the services' own
    // `file.size > MAX` checks always did).
    limits: { ...(options.limits ?? {}), fileSize: maxBytes + 1 },
  });

  @Injectable()
  class LimitedFileMixin implements NestInterceptor {
    // No MulterModule is registered anywhere in the app, so the inner interceptor's
    // optional module-options injection is always `{}` — construct it directly.
    private readonly inner: NestInterceptor = new (Inner as unknown as new () => NestInterceptor)();

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
      try {
        return (await this.inner.intercept(context, next)) as Observable<unknown>;
      } catch (e) {
        if (e instanceof PayloadTooLargeException) {
          throw new PayloadTooLargeException(fileTooLargeMessage(maxBytes));
        }
        throw e;
      }
    }
  }
  return mixin(LimitedFileMixin);
}
