import {
  Controller,
  Get,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { GiftCatalogueService } from './gift-catalogue.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

/**
 * Gift image render path — GET /v1/gift-images?key=<object-key>.
 *
 * Gift images live in the PRIVATE uploads bucket (it also holds KYC/POSM data, so a raw
 * storage.googleapis.com URL 403s in a browser). This endpoint streams the bytes through
 * the API — the same posture as the KYC + visibility media proxies — so an <img> tag on
 * any portal page renders the private object.
 *
 * DELIBERATELY carries NO @Roles / @RequirePermission: gift images are non-sensitive,
 * owner-approved catalogue content shown to EVERY portal user (GIFSY admins, tenant
 * admins, AND members browsing the reward catalogue), so it must not be pinned to an
 * admin role. JwtAuthGuard still requires a valid session; the tenant fence is enforced
 * in serveGiftImage by the object key's folder (`_platform/` is portal-wide, a
 * `<clientId>/` image is served only to that tenant or an un-assumed GIFSY operator), and
 * the service refuses any key outside the gift-catalogue prefix — so this can never be
 * turned into an arbitrary-object reader against the shared private bucket.
 */
@Controller('gift-images')
export class GiftImageController {
  constructor(private readonly catalogue: GiftCatalogueService) {}

  // @SkipThrottle: the member reward catalogue renders one <img> per gift, so a single
  // page load fires dozens of GETs to this route. The global 60/min/IP throttler would
  // 429 them (it's keyed by IP, and field reps share office/carrier-NAT IPs) → broken
  // thumbnails. Browser caching (Cache-Control below) already bounds repeat loads; the
  // read is a bounded 5 MB image, so it's safe to exempt from the coarse IP limit.
  @SkipThrottle()
  @Get()
  async view(
    @CurrentUser() user: JwtPayload,
    @Query('key') key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { bytes, contentType, cachePublic } = await this.catalogue.serveGiftImage(user, key);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Master (_platform) images are portal-wide → cache a day in the viewer's browser.
    // Per-tenant images → no-store, so a shared browser never serves one tenant's cached
    // image to another user without the server-side tenant fence re-running.
    res.setHeader('Cache-Control', cachePublic ? 'private, max-age=86400' : 'no-store');
    return new StreamableFile(bytes, { type: contentType, disposition: 'inline' });
  }
}
