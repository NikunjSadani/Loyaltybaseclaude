import {
  Body,
  Controller,
  Delete,
  Get,
  Head,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Ip,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { Readable } from 'node:stream';
import { CurrentUser, type JwtPayload } from '../common/decorators/current-user.decorator';
import { Public, Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { LimitedFileInterceptor } from '../common/upload-limits';
import { streamObjectResponse } from '../common/stream-object';
import { HelpAdminService } from './help-admin.service';
import { HelpMemberService } from './help-member.service';
import { HelpMediaService, type HelpMediaTarget } from './help-media.service';
import { HelpMediaLimiter } from './help-media-limiter';
import { CreateHelpTopicDto, ReorderHelpTopicsDto, UpdateHelpTopicDto } from './help.dto';
import {
  HELP_POSTER_MAX_BYTES,
  HELP_VIDEO_PART_BYTES,
  PARTNER_USER_ROLES,
  SALES_USER_ROLES,
} from './help.constants';

/**
 * Help & videos — Gifsy console authoring for ONE client (path :slug). GIFSY_ADMIN only; reads need
 * tenancy:read, every write tenancy:write (the same gate as the client PATCH / branding upload).
 * Static sub-paths (`role-options`, `reorder`) are declared BEFORE the `:id` routes.
 */
@Controller('gifsy/clients/:slug/help-topics')
@Roles('GIFSY_ADMIN')
export class HelpAdminController {
  constructor(private readonly svc: HelpAdminService) {}

  @Get()
  @RequirePermission('tenancy:read')
  list(@CurrentUser() user: JwtPayload, @Param('slug') slug: string) {
    return this.svc.list(user, slug);
  }

  @Get('role-options')
  @RequirePermission('tenancy:read')
  roleOptions(@CurrentUser() user: JwtPayload, @Param('slug') slug: string) {
    return this.svc.roleOptions(user, slug);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('tenancy:write')
  create(@CurrentUser() user: JwtPayload, @Param('slug') slug: string, @Body() dto: CreateHelpTopicDto) {
    return this.svc.create(user, slug, dto);
  }

  @Post('reorder')
  @HttpCode(200)
  @RequirePermission('tenancy:write')
  reorder(@CurrentUser() user: JwtPayload, @Param('slug') slug: string, @Body() dto: ReorderHelpTopicsDto) {
    return this.svc.reorder(user, slug, dto);
  }

  @Patch(':id')
  @RequirePermission('tenancy:write')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() dto: UpdateHelpTopicDto,
  ) {
    return this.svc.update(user, slug, id, dto);
  }

  @Delete(':id')
  @RequirePermission('tenancy:write')
  remove(@CurrentUser() user: JwtPayload, @Param('slug') slug: string, @Param('id') id: string) {
    return this.svc.remove(user, slug, id);
  }

  @Post(':id/poster')
  @HttpCode(200)
  @RequirePermission('tenancy:write')
  @UseInterceptors(LimitedFileInterceptor('file', HELP_POSTER_MAX_BYTES))
  uploadPoster(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.svc.uploadPoster(user, slug, id, file);
  }

  @Delete(':id/poster')
  @RequirePermission('tenancy:write')
  removePoster(@CurrentUser() user: JwtPayload, @Param('slug') slug: string, @Param('id') id: string) {
    return this.svc.removePoster(user, slug, id);
  }

  @Delete(':id/video')
  @RequirePermission('tenancy:write')
  removeVideo(@CurrentUser() user: JwtPayload, @Param('slug') slug: string, @Param('id') id: string) {
    return this.svc.removeVideo(user, slug, id);
  }

  /** Start a chunked video upload (≤ 50 MB as ≤ 8 MiB parts — under the 15 MB Next proxy body cap). */
  @Post(':id/video-uploads')
  @HttpCode(201)
  @RequirePermission('tenancy:write')
  startVideoUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Query('bytes') bytes?: string,
  ) {
    return this.svc.startVideoUpload(user, slug, id, bytes === undefined ? undefined : Number(bytes));
  }

  @Post(':id/video-uploads/:uploadId/parts/:n')
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @RequirePermission('tenancy:write')
  @UseInterceptors(LimitedFileInterceptor('file', HELP_VIDEO_PART_BYTES))
  putVideoPart(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Param('uploadId') uploadId: string,
    @Param('n') n: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.svc.putVideoPart(user, slug, id, uploadId, n, file);
  }

  @Post(':id/video-uploads/:uploadId/complete')
  @HttpCode(200)
  @RequirePermission('tenancy:write')
  completeVideoUpload(
    @CurrentUser() user: JwtPayload,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Param('uploadId') uploadId: string,
  ) {
    return this.svc.completeVideoUpload(user, slug, id, uploadId);
  }
}

/** GET /v1/sales/help-topics[/:id] — published SALES guides for the caller's tenant + role. */
@Controller('sales/help-topics')
@Roles(...SALES_USER_ROLES)
export class SalesHelpController {
  constructor(private readonly svc: HelpMemberService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.svc.list(user, 'SALES');
  }

  @Get(':id')
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.get(user, 'SALES', id);
  }
}

/** GET /v1/partner/help-topics[/:id] — published PARTNER guides for the caller's tenant + outlet type. */
@Controller('partner/help-topics')
@Roles(...PARTNER_USER_ROLES)
export class PartnerHelpController {
  constructor(private readonly svc: HelpMemberService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.svc.list(user, 'PARTNER');
  }

  @Get(':id')
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.get(user, 'PARTNER', id);
  }
}

/**
 * GET|HEAD /v1/help/media?token=<jwt> — PUBLIC tokenized stream of ONE help video / poster (the "signed URL").
 * No session (an HTML5 <video> fetches with no Authorization header); the HS256 token is the sole authority —
 * see HelpMediaService. Any failure → bare 404. Supports Range (206) for seeking / iOS playback.
 * Exempt from the GLOBAL throttle (its bucket keys on req.ip, which behind the Next rewrite is one value for every
 * viewer) but limited by HelpMediaLimiter: per token (requests/min + concurrent streams) and a per-IP backstop.
 * HEAD answers the same headers WITHOUT opening the object.
 */
@Controller('help')
export class HelpMediaController {
  constructor(
    private readonly media: HelpMediaService,
    private readonly limiter: HelpMediaLimiter,
  ) {}

  private limit(token: string | undefined, ip: string | undefined, res: Response): string {
    const key = HelpMediaLimiter.tokenKey(typeof token === 'string' ? token : '');
    try {
      this.limiter.check(key, ip);
    } catch (e) {
      res.setHeader('Retry-After', '10');
      throw e;
    }
    return key;
  }

  private setHeaders(res: Response, target: HelpMediaTarget | { unsatisfiable: true; size: number }): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    if ('unsatisfiable' in target) {
      res.setHeader('Content-Range', `bytes */${target.size}`);
      throw new HttpException('Range not satisfiable', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
    }
    res.setHeader('Content-Type', target.contentType);
    res.setHeader('Content-Disposition', 'inline');
    if (target.range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${target.range.start}-${target.range.end}/${target.size}`);
    }
  }

  // Declared BEFORE the GET so Express routes HEAD here (otherwise a GET route also answers HEAD and would open
  // the object only to discard the body).
  @Public()
  @SkipThrottle()
  @Head('media')
  async head(
    @Query('token') token: string,
    @Headers('range') range: string | undefined,
    @Ip() ip: string,
    @Res() res: Response,
  ): Promise<void> {
    this.limit(token, ip, res);
    const target = await this.media.inspect(token, range);
    this.setHeaders(res, target);
    if (!('unsatisfiable' in target)) res.setHeader('Content-Length', String(target.length));
    res.end();
  }

  @Public()
  @SkipThrottle()
  @Get('media')
  async view(
    @Query('token') token: string,
    @Headers('range') range: string | undefined,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const tokenKey = this.limit(token, ip, res);
    const target = await this.media.inspect(token, range);
    this.setHeaders(res, target);
    if ('unsatisfiable' in target) throw new NotFoundException(); // unreachable — setHeaders threw 416
    let release: () => void;
    try {
      release = this.limiter.acquireStream(tokenKey);
    } catch (e) {
      res.setHeader('Retry-After', '5');
      throw e;
    }
    res.once('close', release);
    let stream: Readable;
    try {
      stream = this.media.openStream(target);
    } catch (e) {
      release();
      throw e;
    }
    return streamObjectResponse(res, { stream, size: target.length }, { type: target.contentType, disposition: 'inline' });
  }
}
