import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser, type JwtPayload } from '../common/decorators/current-user.decorator';
import { ExportsService } from './exports.service';
import type { ExportList, ExportQueuedResponse, ExportRequestDto } from './exports.contract';

/**
 * Downloads page API (platform/docs/plans/DOWNLOADS-PAGE.md). No @Roles here on purpose: every route is gated
 * PER KIND by ExportsService (the same roles/permission as the report's own endpoint), and the list only ever shows
 * the caller's own requests in their (assumed) tenant.
 *   POST admin/exports              {kind, params} → 202 ExportQueuedResponse (400 / 403 / 409 / 503)
 *   GET  admin/exports?cursor=      → ExportList (own, newest first)
 *   GET  admin/exports/:id          → ExportRequestDto
 *   GET  admin/exports/:id/download → the file, streamed from storage (404 cross-tenant, 409 not ready, 410 expired)
 */
@Controller('admin/exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @HttpCode(202)
  create(@CurrentUser() user: JwtPayload, @Body() body: unknown, @Req() req: Request): Promise<ExportQueuedResponse> {
    const b = (body && typeof body === 'object' ? body : {}) as { kind?: unknown; params?: unknown };
    if (typeof b.kind !== 'string' || !b.kind.trim()) throw new BadRequestException('Choose which report to download.');
    if (b.params !== undefined && (b.params === null || typeof b.params !== 'object' || Array.isArray(b.params))) {
      throw new BadRequestException('Report filters must be an object.');
    }
    return this.exports.request(user, b.kind.trim(), b.params ?? {}, req);
  }

  @Get()
  list(@CurrentUser() user: JwtPayload, @Query('cursor') cursor?: string): Promise<ExportList> {
    return this.exports.list(user, typeof cursor === 'string' && cursor ? cursor : undefined);
  }

  @Get(':id')
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<ExportRequestDto> {
    return this.exports.get(user, id);
  }

  @Get(':id/download')
  download(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.exports.download(user, id);
  }
}
