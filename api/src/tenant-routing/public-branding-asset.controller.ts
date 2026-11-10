import { Controller, Get, NotFoundException, Query, Res, StreamableFile } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/decorators/roles.decorator';
import { sniffFileType } from '../common/file-signature';
import { StorageService } from '../storage/storage.service';
import {
  BRANDING_ASSET_MAX_BYTES,
  BRANDING_ASSET_MIME,
  normaliseBrandingKey,
} from '../storage/branding-asset';
import { BrandingAssetCache } from './branding-asset-cache';
import { TenantRoutingService } from './tenant-routing.service';

/** Objects at or below this size are buffered + cached; larger ones are streamed. */
const CACHEABLE_MAX_BYTES = 512 * 1024;
/** Enough leading bytes for every signature sniffFileType checks (WEBP/HEIC need 12). */
const SNIFF_HEAD_BYTES = 16;

/**
 * Mid-stream GCS failure on the large-object path. Nest's default StreamableFile handler
 * answers 400 with the raw storage error text (bucket name, object path) while the image,
 * length and 1-year immutable cache headers are already set. Instead:
 *  - headers not yet sent → drop the image/length/cache headers, `no-store`, bare 404 with
 *    the API's generic error envelope — never the storage message;
 *  - headers already sent → destroy the socket so the client sees a FAILED transfer (a
 *    short body under the declared Content-Length), never a "complete" truncated image.
 * The error itself is still logged server-side by StreamableFile's error logger.
 */
/** The Express response members the handler uses (Nest types it as a narrower shape). */
interface StreamErrorResponse {
  headersSent: boolean;
  destroyed: boolean;
  statusCode: number;
  removeHeader(name: string): void;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
  destroy(): void;
}

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

/**
 * GET /v1/public/branding-assets?key=branding/<slug>/<yyyy-mm>/<uuid>-<name>.<ext>
 *
 * PUBLIC, unauthenticated image route for tenant branding (logo / wordmarks / favicon),
 * which the sign-in screen and browser tab need BEFORE login. The uploads bucket is
 * private (it also holds KYC docs + POSM photos), so the bytes go through the API.
 *
 * Security posture (it reads a shared private bucket without auth, so it is deliberately narrow):
 *  - `@Public()` opts out of JwtAuthGuard; TenantGuard skips @Public routes; no @Roles /
 *    @RequirePermission. Nothing is user- or tenant-specific: branding is already public
 *    on every tenant's login page.
 *  - The key must match the EXACT upload shape under `branding/` (normaliseBrandingKey):
 *    no `..`, `\`, `//`, `%`, leading `/`, other prefixes or extra segments — rejected
 *    BEFORE any storage call, so it can never become an arbitrary-object reader.
 *  - Size checked from metadata BEFORE any bytes are read (5 MB = the upload cap). The
 *    response type comes from the BYTES (magic sniff), never the stored metadata, and only
 *    PNG/JPEG/WEBP/GIF are served — anything else (PDF, HTML/SVG, TIFF…) 404s.
 *    `nosniff` + `inline`.
 *  - Every failure is a bare 404 (no "exists but forbidden" oracle).
 *  - `@SkipThrottle()` — exactly as gift-images: every browser request reaches the API via
 *    the frontend's `/api` → `/v1` rewrite, so the global IP throttler (no trust-proxy) would
 *    key ALL users on the frontend's egress IP and 429 logos platform-wide. Load is bounded
 *    instead by the strict key shape, the size cap, the immutable browser/CDN cache and the
 *    in-process cache below (positive LRU 50 entries / 20 MB; misses remembered 30 s).
 *  - `Cache-Control: public, max-age=1y, immutable` — keys embed a fresh uuid per upload,
 *    so an object's bytes never change under the same URL.
 *  - Keys whose slug segment is not an existing tenant 404 (negative-cached) before any
 *    storage call (TenantRoutingService.isKnownTenantSlug — cached, fails open).
 *  - Small objects (≤ 512 KB — every real logo/favicon) are downloaded once + cached; larger
 *    ones are STREAMED from GCS after sniffing only their first 16 bytes, with a stream
 *    error handler that never leaks storage error text (streamErrorHandler).
 */
@Controller('public/branding-assets')
export class PublicBrandingAssetController {
  private readonly cache = new BrandingAssetCache({
    maxEntries: 50,
    maxBytes: 20 * 1024 * 1024,
    missTtlMs: 30_000,
    maxMisses: 500,
  });

  constructor(
    private readonly storage: StorageService,
    private readonly routing: TenantRoutingService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get()
  async get(
    @Query('key') rawKey: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const key = normaliseBrandingKey(rawKey);
    if (!key) throw new NotFoundException();

    const cached = this.cache.get(key);
    if (cached) return this.send(res, cached.bytes, cached.contentType);
    if (this.cache.isMiss(key)) throw new NotFoundException();

    const miss = (): never => {
      this.cache.markMiss(key);
      throw new NotFoundException();
    };

    // Load shedding: a key for a tenant that doesn't exist never reaches storage.
    if (!(await this.routing.isKnownTenantSlug(key.split('/')[1]))) miss();

    const meta = await this.storage.statObject(key);
    if (!meta || meta.size <= 0 || meta.size > BRANDING_ASSET_MAX_BYTES) miss();

    if (meta!.size <= CACHEABLE_MAX_BYTES) {
      // Size already checked via stat → download directly (no second metadata call).
      const bytes = await this.storage.downloadObject(key);
      if (!bytes || bytes.length > CACHEABLE_MAX_BYTES) miss();
      const mime = this.renderableMime(bytes!);
      if (!mime) miss();
      this.cache.set(key, { bytes: bytes!, contentType: mime! });
      return this.send(res, bytes!, mime!);
    }

    // Larger object: sniff the head, then stream (never buffered, never cached).
    const head = await this.readHead(key);
    const mime = head && this.renderableMime(head);
    if (!mime) miss();
    this.setHeaders(res, mime!);
    res.setHeader('Content-Length', String(meta!.size));
    return new StreamableFile(this.storage.openReadStream(key), {
      type: mime!,
      disposition: 'inline',
      length: meta!.size,
    }).setErrorHandler((err, r) => streamErrorHandler(err, r as unknown as StreamErrorResponse));
  }

  private renderableMime(bytes: Buffer): string | null {
    const sniffed = sniffFileType(bytes);
    return sniffed && BRANDING_ASSET_MIME.has(sniffed.mime) ? sniffed.mime : null;
  }

  private async readHead(key: string): Promise<Buffer | null> {
    try {
      const chunks: Buffer[] = [];
      for await (const c of this.storage.openReadStream(key, { start: 0, end: SNIFF_HEAD_BYTES - 1 })) {
        chunks.push(Buffer.from(c as Buffer));
      }
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  private setHeaders(res: Response, mime: string): void {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }

  private send(res: Response, bytes: Buffer, mime: string): StreamableFile {
    this.setHeaders(res, mime);
    return new StreamableFile(bytes, { type: mime, disposition: 'inline' });
  }
}
