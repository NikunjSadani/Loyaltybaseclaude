import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { LimitedFileInterceptor, MEDIA_UPLOAD_MAX_BYTES } from '../common/upload-limits';
import type { Response } from 'express';
import { streamObjectResponse } from '../common/stream-object';
import { VisibilityAdminService } from './visibility-admin.service';
import { VisibilityMediaService } from './visibility-media.service';
import { VisibilityCaptureService } from './visibility-capture.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  ScopeOutletsQueryDto,
  SetVisibilityConfigDto,
  UpsertVisibilityFormDto,
} from './dto/visibility-admin.dto';

/**
 * Visibility (POSM) ADMIN authoring API — GIFSY_ADMIN only (D4). Base path
 * `/v1/visibility`. `@Roles('GIFSY_ADMIN')` is the real gate; a GIFSY_ADMIN passes
 * every @RequirePermission check regardless (RolesGuard is always-on). The service
 * enforces the per-tenant `visibilityEnabled` master switch (+ PHOTO_APPROVAL mode on
 * writes) and, for the media stream, tenant-from-key.
 *
 * ROUTE ORDERING: the static `GET captures/media` route is declared BEFORE any `:id`
 * param routes so `media` is never swallowed by a param segment (the scheme
 * route-ordering gotcha). Capture/review/report/sales routes belong to Stream B and
 * are NOT defined here.
 */
@Controller('visibility')
@Roles('GIFSY_ADMIN')
export class VisibilityAdminController {
  constructor(
    private readonly admin: VisibilityAdminService,
    private readonly media: VisibilityMediaService,
    private readonly capture: VisibilityCaptureService,
  ) {}

  // ── Auth-gated media stream (declared FIRST — static path before any :id route) ──
  // M4/D15 — reachable by GIFSY_ADMIN + CLIENT_ADMIN (tenant export photo links) + the
  // SALES capture roles (capture read-back). This method-level @Roles OVERRIDES the class
  // GIFSY_ADMIN gate (RolesGuard uses getAllAndOverride). The service pins every NON-GIFSY
  // caller to their own tenant via the object-key tenant folder, so a caller can only ever
  // read their own tenant's visibility-media keys.
  @Get('captures/media')
  @Roles(
    'GIFSY_ADMIN',
    'CLIENT_ADMIN',
    'SALES_HO',
    'SALES_STATE_HEAD',
    'SALES_ASM',
    'SALES_SO',
    'SALES_ISR',
  )
  @RequirePermission('visibility:read')
  async viewMedia(
    @CurrentUser() user: JwtPayload,
    @Query('key') key: string,
    @Res({ passthrough: true }) res: Response,
    // Optional capture-id hint sent by the sales photo viewer (a direct row lookup); ignored by everyone else.
    @Query('c') captureHint?: string,
  ): Promise<StreamableFile> {
    // Sales photo view tightening — SALES roles only, and only for a tenant with salesPhotoViewLevels set (see
    // VisibilityCaptureService.assertSalesMediaAccess). Admin roles / every other tenant: a no-op (unchanged).
    await this.capture.assertSalesMediaAccess(user, key, captureHint);
    const { stream, size, contentType, inline } = await this.media.viewMedia(user, key);
    const disposition = inline ? 'inline' : 'attachment; filename="media"';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Sales roles on a sales-photo-view tenant: keys are immutable and access is re-checked on every request, so the
    // phone may keep its own private copy for 5 minutes (thumbnail → full view is one download). Everyone else: no-store
    // exactly as before.
    if (await this.capture.salesMediaCacheable(user)) {
      res.setHeader('Cache-Control', 'private, max-age=300');
      // The private copy belongs to THIS signed-in session — never reused for another cookie / bearer (N3).
      res.setHeader('Vary', 'Cookie, Authorization');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    return streamObjectResponse(res, { stream, size }, { type: contentType, disposition });
  }

  // ── Config ───────────────────────────────────────────────────────────────────
  @Get('config')
  @RequirePermission('visibility:read')
  getConfig(@CurrentUser() user: JwtPayload) {
    return this.admin.getConfig(user.clientId);
  }

  @Put('config')
  @RequirePermission('visibility:write')
  setConfig(@CurrentUser() user: JwtPayload, @Body() dto: SetVisibilityConfigDto) {
    return this.admin.setConfig(user, dto);
  }

  // ── The tenant's real sales levels (config editor: who sees team photos) ─────────
  @Get('config/sales-levels')
  @RequirePermission('visibility:read')
  salesLevels(@CurrentUser() user: JwtPayload) {
    return this.admin.listSalesLevels(user.clientId);
  }

  // ── Capture form (versioned) ───────────────────────────────────────────────────
  @Get('form')
  @RequirePermission('visibility:read')
  getForm(@CurrentUser() user: JwtPayload) {
    return this.admin.getForm(user.clientId);
  }

  @Put('form')
  @RequirePermission('visibility:write')
  upsertForm(@CurrentUser() user: JwtPayload, @Body() dto: UpsertVisibilityFormDto) {
    return this.admin.upsertForm(user, dto.formSchema);
  }

  // ── Outlets in the configured scope (admin) ────────────────────────────────────
  @Get('outlets')
  @RequirePermission('visibility:read')
  listOutlets(@CurrentUser() user: JwtPayload, @Query() query: ScopeOutletsQueryDto) {
    return this.admin.listOutletsInScope(user.clientId, query);
  }

  // ── Media upload (multipart) — magic-byte guarded, returns the stored key ───────
  @Post('media')
  @RequirePermission('visibility:write')
  @UseInterceptors(LimitedFileInterceptor('file', MEDIA_UPLOAD_MAX_BYTES))
  uploadMedia(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.media.uploadMedia(user, file);
  }
}
