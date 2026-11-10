import { Controller, Get, NotFoundException, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/decorators/roles.decorator';
import { sniffFileType } from '../common/file-signature';
import { StorageService } from '../storage/storage.service';
import {
  BRANDING_ASSET_MAX_BYTES,
  BRANDING_ASSET_MIME,
  normaliseBrandingKey,
} from '../storage/branding-asset';

/**
 * GET /v1/public/branding-assets?key=branding/<slug>/<yyyy-mm>/<uuid>-<name>.<ext>
 *
 * PUBLIC, unauthenticated image route for tenant branding (logo / wordmarks / favicon),
 * which the sign-in screen and browser tab need BEFORE login. The uploads bucket is
 * private (it also holds KYC docs + POSM photos), so bytes are streamed through the API.
 *
 * Security posture (it reads a shared private bucket without auth, so it is deliberately narrow):
 *  - `@Public()` opts out of JwtAuthGuard; TenantGuard skips @Public routes; no @Roles /
 *    @RequirePermission. Nothing is user- or tenant-specific: branding is already public
 *    on every tenant's login page.
 *  - The key must match the EXACT upload shape under `branding/` (normaliseBrandingKey):
 *    no `..`, `\`, `//`, `%`, leading `/`, other prefixes or extra segments — rejected
 *    BEFORE any storage call, so it can never become an arbitrary-object reader.
 *  - Read capped at the 5 MB upload cap; the response type comes from the BYTES (magic
 *    sniff), never the stored metadata, and only PNG/JPEG/WEBP/GIF are served — anything
 *    else (PDF, HTML/SVG, TIFF…) 404s. `nosniff` + `inline`.
 *  - Every failure is a bare 404 (no "exists but forbidden" oracle).
 *  - Rate-limited by the global ThrottlerGuard (no @SkipThrottle — unlike gift-images, a
 *    page shows at most ~3 branding images and the immutable cache makes repeats free).
 *  - `Cache-Control: public, max-age=1y, immutable` — keys embed a fresh uuid per upload,
 *    so an object's bytes never change under the same URL.
 */
@Controller('public/branding-assets')
export class PublicBrandingAssetController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get()
  async get(
    @Query('key') rawKey: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const key = normaliseBrandingKey(rawKey);
    if (!key) throw new NotFoundException();

    const file = await this.storage.downloadBytes(key, BRANDING_ASSET_MAX_BYTES);
    if (!file) throw new NotFoundException();

    const sniffed = sniffFileType(file.bytes);
    if (!sniffed || !BRANDING_ASSET_MIME.has(sniffed.mime)) throw new NotFoundException();

    res.setHeader('Content-Type', sniffed.mime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return new StreamableFile(file.bytes, { type: sniffed.mime, disposition: 'inline' });
  }
}
