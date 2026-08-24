import { Controller, Get, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { GiftDisbursalService } from './gift-disbursal.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { GiftDisbursalQueryDto } from './dto/vendor.dto';

/**
 * Gift Disbursal report (Wave 2, §6) — /v1/admin/gift-disbursal. The ONE gift endpoint
 * a tenant admin can read: @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN'). A CLIENT_ADMIN is
 * force-scoped to their OWN tenant in the service; Gifsy reads all (optionally narrowed
 * by clientId / vendorId). Value == 194R basis (DELIVERED valuePaise).
 */
@Controller('admin/gift-disbursal')
@Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
export class GiftDisbursalController {
  constructor(private readonly disbursal: GiftDisbursalService) {}

  @Get()
  @RequirePermission('rewards:read')
  report(@CurrentUser() user: JwtPayload, @Query() q: GiftDisbursalQueryDto) {
    return this.disbursal.report(user, q);
  }

  @Get('export')
  @RequirePermission('rewards:read')
  async export(
    @CurrentUser() user: JwtPayload,
    @Query() q: GiftDisbursalQueryDto,
    @Res({ passthrough: true }) _res: Response,
  ): Promise<StreamableFile> {
    const buffer = await this.disbursal.exportXlsx(user, q);
    const filename = `gift-disbursal-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
