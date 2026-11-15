import { StreamableFile } from '@nestjs/common';
import type { Readable } from 'node:stream';

/**
 * Streaming helpers for the private photo/document proxies (memory-safety 2026-11-13).
 *
 * The proxies used to `downloadBytes()` each object into a Buffer and send it; a
 * reviewer gallery (30 photos × a few reviewers) then held 50–250 MB at once. They now
 * pipe the GCS read stream straight to the response.
 */

/** The Express response members the error handler uses (Nest types it narrower). */
export interface StreamErrorResponse {
  headersSent: boolean;
  destroyed: boolean;
  statusCode: number;
  removeHeader(name: string): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
  destroy(): void;
}

/**
 * Mid-stream storage failure. Nest's default StreamableFile handler answers 400 with the
 * raw storage error text (bucket name, object path). Instead:
 *  - headers not yet sent → drop the content headers, `no-store`, bare 404 with the API's
 *    generic error envelope — never the storage message;
 *  - headers already sent → destroy the socket so the client sees a FAILED transfer (a
 *    short body under the declared Content-Length), never a "complete" truncated file.
 */
export function streamErrorHandler(_err: Error, res: StreamErrorResponse): void {
  if (res.destroyed) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const h of ['Content-Type', 'Content-Length', 'Content-Disposition', 'Cache-Control']) {
    res.removeHeader(h);
  }
  res.statusCode = 404;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ success: false, error: 'Not found' }));
}

/** Minimal response surface needed to tie the source stream's life to the response. */
interface ClosableResponse {
  once(event: 'close', cb: () => void): unknown;
}

/**
 * Wrap an opened object stream as a StreamableFile:
 *  - `Content-Length` from the stored size (so the browser shows progress and detects truncation);
 *  - a storage error never leaks its message (streamErrorHandler);
 *  - when the client goes away mid-transfer the GCS read stream is destroyed (Node's `pipe`
 *    does not do that on its own, which would leave the source socket open until it times out).
 */
export function streamObjectResponse(
  res: ClosableResponse,
  obj: { stream: Readable; size: number },
  opts: { type: string; disposition: string },
): StreamableFile {
  const { stream } = obj;
  res.once('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  return new StreamableFile(stream, {
    type: opts.type,
    disposition: opts.disposition,
    length: obj.size,
  }).setErrorHandler((err, r) => streamErrorHandler(err, r as unknown as StreamErrorResponse));
}
