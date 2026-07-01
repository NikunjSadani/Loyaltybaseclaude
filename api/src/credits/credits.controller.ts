import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { CreditsService } from './credits.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  CreateBatchDto,
  CreateFieldDto,
  CreatePayoutDownloadDto,
  CreateReversalDto,
  ListBatchesQueryDto,
  ListFieldsQueryDto,
  ListPayoutDownloadsQueryDto,
  ListReversalsQueryDto,
  PatchFieldDto,
  PatchReversalDto,
  UtrUploadQueryDto,
} from './dto/credits.dto';

/**
 * Awards & Credits (§12a) — re-homed from
 * platform/src/app/api/admin/credits/* onto /v1/admin/credits.
 * Thin HTTP adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated) and @Roles. Responses are enveloped globally by
 * TransformInterceptor — except the payout-download xlsx, which streams as a
 * StreamableFile (passed through unwrapped).
 *
 * Role gates mirror the source: CLIENT_ADMIN + GIFSY_ADMIN for batch/field/outlet
 * management; GIFSY_ADMIN-only for payout downloads, UTR marking, and reversal
 * approval.
 */
@Controller('admin/credits')
export class CreditsController {
  constructor(private readonly credits: CreditsService) {}

  // ─── Batches ───────────────────────────────────────────────────────────────

  @Get('batches')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  listBatches(@CurrentUser() user: JwtPayload, @Query() query: ListBatchesQueryDto) {
    return this.credits.listBatches(user, query);
  }

  @Post('batches')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:upload')
  createBatch(@CurrentUser() user: JwtPayload, @Body() dto: CreateBatchDto) {
    return this.credits.createBatch(user, dto);
  }

  @Get('batches/:id')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  getBatch(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.credits.getBatch(user, id);
  }

  @Post('batches/:id/confirm')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:confirm_payout')
  confirmBatch(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.credits.confirmBatch(user, id);
  }

  @Get('batches/:id/reversals')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  listBatchReversals(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.credits.listBatchReversals(user, id);
  }

  @Post('batches/:id/reversals')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:request_reversal')
  createReversal(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateReversalDto,
  ) {
    return this.credits.createReversal(user, id, dto);
  }

  // ─── Eligible outlets ──────────────────────────────────────────────────────

  @Get('eligible-outlets')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  eligibleOutlets(@CurrentUser() user: JwtPayload) {
    return this.credits.eligibleOutlets(user);
  }

  // ─── Outlet types (for the field award editor) ─────────────────────────────

  @Get('outlet-types')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  listOutletTypes(@CurrentUser() user: JwtPayload) {
    return this.credits.listOutletTypes(user);
  }

  // ─── Fields ────────────────────────────────────────────────────────────────

  @Get('fields')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:read')
  listFields(@CurrentUser() user: JwtPayload, @Query() query: ListFieldsQueryDto) {
    return this.credits.listFields(user, query);
  }

  @Post('fields')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:manage_fields')
  createField(@CurrentUser() user: JwtPayload, @Body() dto: CreateFieldDto) {
    return this.credits.createField(user, dto);
  }

  @Patch('fields/:id')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @RequirePermission('credits:manage_fields')
  patchField(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PatchFieldDto,
  ) {
    return this.credits.patchField(user, id, dto);
  }

  // ─── Payout downloads (GIFSY_ADMIN only) ───────────────────────────────────

  @Get('payout-downloads')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:download_bank_file')
  listPayoutDownloads(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListPayoutDownloadsQueryDto,
  ) {
    return this.credits.listPayoutDownloads(user, query);
  }

  @Post('payout-downloads')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:download_bank_file')
  async createPayoutDownload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreatePayoutDownloadDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, downloadCode, downloadId } = await this.credits.createPayoutDownload(
      user,
      dto,
    );
    res.setHeader('X-Download-Code', downloadCode);
    res.setHeader('X-Download-Id', downloadId);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="payout-${downloadCode}.xlsx"`,
    });
  }

  @Post('payout-downloads/:id/utr')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:mark_paid')
  @UseInterceptors(FileInterceptor('file'))
  uploadUtr(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Query() query: UtrUploadQueryDto,
  ) {
    return this.credits.uploadUtr(user, id, file, query.apply === 'true');
  }

  // ─── Reversals (GIFSY_ADMIN only) ──────────────────────────────────────────

  @Get('reversals')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:read')
  listReversals(@CurrentUser() user: JwtPayload, @Query() query: ListReversalsQueryDto) {
    return this.credits.listReversals(user, query);
  }

  @Patch('reversals/:id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('credits:approve_reversal')
  patchReversal(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: PatchReversalDto,
  ) {
    return this.credits.patchReversal(user, id, dto);
  }
}
