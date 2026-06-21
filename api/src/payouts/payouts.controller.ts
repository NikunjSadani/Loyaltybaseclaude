import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PayoutsService } from './payouts.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import {
  BatchDetailQueryDto,
  CreateBatchDto,
  ListBatchesQueryDto,
  ListTransactionsQueryDto,
  PayoutUtrUploadQueryDto,
  ReceiveFundDto,
  ReconciliationQueryDto,
} from './dto/payouts.dto';

/**
 * Credits & Payouts API — re-homed from platform/src/app/api/payouts/* onto /v1.
 * Thin adapter: auth (JWT) + tenant scope come from @CurrentUser(); RBAC via
 * @RequirePermission (flag-gated). Q1 (2026-06-19): payout management is GIFSY-only —
 * ALL endpoints (read + mutating) are @Roles('GIFSY_ADMIN'); MIS_USER dropped. Responses are enveloped
 * globally by TransformInterceptor (except the StreamableFile download, which
 * passes through unwrapped).
 */
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get('transactions')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:read')
  listTransactions(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListTransactionsQueryDto,
  ) {
    return this.payouts.listTransactions(user, query);
  }

  @Get('fund')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:read')
  getFundSummary(@CurrentUser() user: JwtPayload) {
    return this.payouts.getFundSummary(user);
  }

  @Post('fund/receive')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:manage_fund')
  receiveFund(@CurrentUser() user: JwtPayload, @Body() dto: ReceiveFundDto) {
    return this.payouts.receiveFund(user, dto);
  }

  @Get('batches')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:read')
  listBatches(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListBatchesQueryDto,
  ) {
    return this.payouts.listBatches(user, query);
  }

  @Post('batches')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:process_batch')
  createBatch(@CurrentUser() user: JwtPayload, @Body() dto: CreateBatchDto) {
    return this.payouts.createBatch(user, dto);
  }

  @Get('batches/:id')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:read')
  getBatch(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query() query: BatchDetailQueryDto,
  ) {
    return this.payouts.getBatch(user, id, query);
  }

  @Post('batches/:id/assign-pending')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:process_batch')
  assignPending(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.payouts.assignPendingTransactions(user, id);
  }

  @Post('batches/:id/process')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:process_batch')
  processBatch(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.payouts.processBatch(user, id);
  }

  @Get('batches/:id/utr-template')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:reconcile')
  async utrTemplate(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.payouts.buildPayoutUtrTemplate(user, id);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Post('batches/:id/utr')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:reconcile')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB ceiling — bound memory on parse
      fileFilter: (_req, file, cb) =>
        /\.(xlsx|xls)$/i.test(file.originalname)
          ? cb(null, true)
          : cb(new BadRequestException('Only .xlsx/.xls files are accepted'), false),
    }),
  )
  uploadUtr(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Query() query: PayoutUtrUploadQueryDto,
  ) {
    return this.payouts.uploadPayoutUtr(user, id, file, query.apply === 'true');
  }

  @Get('reconciliation')
  @Roles('GIFSY_ADMIN')
  @RequirePermission('payouts:reconcile')
  async reconciliation(
    @CurrentUser() user: JwtPayload,
    @Query() query: ReconciliationQueryDto,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.payouts.buildReconciliationFile(
      user,
      query,
    );
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }
}
