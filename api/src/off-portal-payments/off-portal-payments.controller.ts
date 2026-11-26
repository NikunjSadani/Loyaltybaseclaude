import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { LimitedFileInterceptor, SPREADSHEET_UPLOAD_MAX_BYTES } from '../common/upload-limits';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { OffPortalPaymentsService } from './off-portal-payments.service';
import { OffPortalConfirmDto, OffPortalListQueryDto, OffPortalVoidDto } from './dto/off-portal-payments.dto';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Off-portal payments register (owner-approved 2026-11-25, platform-wide).
 *  - template / preview / confirm / void: GIFSY_ADMIN only, ASSUMED into the client (service re-checks; staff and client
 *    admins are refused).
 *  - list / export / uploads: that admin or the client's own CLIENT_ADMIN (PII masked for anyone but a Gifsy admin).
 */
@Controller('admin/off-portal-payments')
export class OffPortalPaymentsController {
  constructor(private readonly svc: OffPortalPaymentsService) {}

  @Get('template')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  template(@CurrentUser() user: JwtPayload, @Res({ passthrough: true }) res: Response): StreamableFile {
    this.svc.writerClient(user);
    res.setHeader('Content-Disposition', 'attachment; filename="off-portal-payments-template.xlsx"');
    return new StreamableFile(this.svc.template(), { type: XLSX_TYPE });
  }

  @Post('preview')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(LimitedFileInterceptor('file', SPREADSHEET_UPLOAD_MAX_BYTES))
  preview(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File) {
    return this.svc.preview(user, file);
  }

  @Post('confirm')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(LimitedFileInterceptor('file', SPREADSHEET_UPLOAD_MAX_BYTES))
  confirm(@CurrentUser() user: JwtPayload, @UploadedFile() file: Express.Multer.File, @Body() dto: OffPortalConfirmDto) {
    return this.svc.confirm(user, file, dto);
  }

  @Post(':id/void')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  @HttpCode(HttpStatus.OK)
  void(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: OffPortalVoidDto) {
    return this.svc.void(user, id, dto.reason);
  }

  @Get()
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('payouts:read')
  list(@CurrentUser() user: JwtPayload, @Query() q: OffPortalListQueryDto) {
    return this.svc.list(user, q);
  }

  @Get('uploads')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('payouts:read')
  uploads(@CurrentUser() user: JwtPayload) {
    return this.svc.uploads(user);
  }

  @Get('export')
  @Roles('GIFSY_ADMIN', 'CLIENT_ADMIN')
  @RequirePermission('payouts:read')
  async export(@CurrentUser() user: JwtPayload, @Query() q: OffPortalListQueryDto): Promise<StreamableFile> {
    const { buffer, filename } = await this.svc.exportXlsx(user, q);
    return new StreamableFile(buffer, { type: XLSX_TYPE, disposition: `attachment; filename="${filename}"` });
  }
}
