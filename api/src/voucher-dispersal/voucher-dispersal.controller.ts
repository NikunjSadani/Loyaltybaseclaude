import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Param,
  Patch,
  PipeTransform,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Public, Roles } from '../common/decorators/roles.decorator';
import { LimitedFileInterceptor, SPREADSHEET_UPLOAD_MAX_BYTES } from '../common/upload-limits';
import { VoucherDispersalService } from './voucher-dispersal.service';
import { VoucherDispersalProcessor } from './voucher-dispersal.processor';
import {
  ConfirmDispersalCampaignDto,
  CreateDispersalCampaignDto,
  EditDispersalCampaignDto,
  ListDispersalCampaignsQueryDto,
  MarkNotBoughtDto,
  ListDispersalRowsQueryDto,
} from './dto/voucher-dispersal.dto';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Highest batch number accepted in a path / query (a bigger value is a 400, never a DB Int overflow 500). */
export const MAX_BATCH_NUMBER = 100_000;

/** `:n` batch number — a whole number 1..MAX_BATCH_NUMBER, else 400 (money-audit M7). */
@Injectable()
export class BatchNumberPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const v = String(value ?? '').trim();
    const n = /^\d{1,9}$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_BATCH_NUMBER) {
      throw new BadRequestException(`Batch number must be a whole number from 1 to ${MAX_BATCH_NUMBER}.`);
    }
    return n;
  }
}

/** Same .xlsx-only, size-capped multipart interceptor for the first file and every later batch. */
const xlsxUpload = () =>
  UseInterceptors(
    LimitedFileInterceptor('file', SPREADSHEET_UPLOAD_MAX_BYTES, {
      fileFilter: (_req, file, cb) =>
        /\.xlsx$/i.test(file.originalname)
          ? cb(null, true)
          : cb(new BadRequestException('Only .xlsx files are accepted — download the template and fill it in.'), false),
    }),
  );

/**
 * Voucher Dispersal — `/v1/admin/voucher-dispersal/*`. GIFSY_ADMIN ONLY.
 * `@Roles('GIFSY_ADMIN')` with NO @RequirePermission → RolesGuard 403s every tenant role and every
 * GIFSY_STAFF; the service re-checks role === 'GIFSY_ADMIN' at the data boundary. Platform-level:
 * campaigns are not tenant-scoped (an assumed admin still sees all campaigns).
 */
@Controller('admin/voucher-dispersal')
@Roles('GIFSY_ADMIN')
export class VoucherDispersalController {
  constructor(private readonly svc: VoucherDispersalService) {}

  @Get('brands')
  brands(@CurrentUser() user: JwtPayload) {
    return this.svc.brands(user);
  }

  @Get('template.xlsx')
  async template(@CurrentUser() user: JwtPayload): Promise<StreamableFile> {
    const buf = await this.svc.template(user);
    return new StreamableFile(buf, { type: XLSX_TYPE, disposition: 'attachment; filename="voucher-dispersal-template.xlsx"' });
  }

  @Post('campaigns')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateDispersalCampaignDto) {
    return this.svc.createCampaign(user, dto);
  }

  @Get('campaigns')
  list(@CurrentUser() user: JwtPayload, @Query() q: ListDispersalCampaignsQueryDto) {
    return this.svc.list(user, q);
  }

  @Get('campaigns/:id')
  detail(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.detail(user, id);
  }

  /** Rename and/or change the budget (never below spent + committed). Audited. */
  @Patch('campaigns/:id')
  edit(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: EditDispersalCampaignDto) {
    return this.svc.editCampaign(user, id, dto);
  }

  @Post('campaigns/:id/upload')
  @xlsxUpload()
  upload(@CurrentUser() user: JwtPayload, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.svc.upload(user, id, file);
  }

  @Post('campaigns/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: ConfirmDispersalCampaignDto) {
    return this.svc.confirm(user, id, dto);
  }

  /** Bounded in-request processing pass (the UI calls it while the campaign page is open). */
  @Post('campaigns/:id/process')
  @HttpCode(200)
  process(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.process(user, id);
  }

  @Get('campaigns/:id/rows')
  rows(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Query() q: ListDispersalRowsQueryDto) {
    return this.svc.rows(user, id, q);
  }

  @Get('campaigns/:id/report.xlsx')
  async report(@CurrentUser() user: JwtPayload, @Param('id') id: string): Promise<StreamableFile> {
    const { buffer, fileName } = await this.svc.report(user, id);
    return new StreamableFile(buffer, { type: XLSX_TYPE, disposition: `attachment; filename="${fileName}"` });
  }

  @Post('campaigns/:id/rows/:rowId/resend')
  @HttpCode(200)
  resend(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('rowId') rowId: string) {
    return this.svc.resend(user, id, rowId);
  }

  /** An admin declares a row NOT BOUGHT (only after an unrecognised Hubble status; reason required; audited). */
  @Post('campaigns/:id/rows/:rowId/mark-not-bought')
  @HttpCode(200)
  markNotBought(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('rowId') rowId: string, @Body() dto: MarkNotBoughtDto) {
    return this.svc.markNotBought(user, id, rowId, dto);
  }

    @Post('campaigns/:id/rows/:rowId/retry-buy')
  @HttpCode(200)
  retryBuy(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('rowId') rowId: string) {
    return this.svc.retryBuy(user, id, rowId);
  }

  /** "Add more people": upload another file to a finished campaign → preview (nothing bought yet). */
  @Post('campaigns/:id/batches')
  @xlsxUpload()
  uploadBatch(@CurrentUser() user: JwtPayload, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.svc.uploadBatch(user, id, file);
  }

  /** The preview of a batch still waiting for confirmation (resume after leaving the page). */
  @Get('campaigns/:id/batches/:n')
  batchPreview(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('n', BatchNumberPipe) n: number) {
    return this.svc.batchPreview(user, id, n);
  }

  @Post('campaigns/:id/batches/:n/confirm')
  @HttpCode(200)
  confirmBatch(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('n', BatchNumberPipe) n: number,
    @Body() dto: ConfirmDispersalCampaignDto,
  ) {
    return this.svc.confirmBatch(user, id, n, dto);
  }

  @Post('campaigns/:id/batches/:n/discard')
  @HttpCode(200)
  discardBatch(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Param('n', BatchNumberPipe) n: number) {
    return this.svc.discardBatch(user, id, n);
  }

  @Post('campaigns/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.svc.cancel(user, id);
  }
}

/**
 * POST /v1/voucher-dispersal/drain — Cloud Scheduler driver (restart-proof). `@Public`, header
 * `x-drain-secret`, constant-time compare, FAIL-CLOSED when VOUCHER_DISPERSAL_DRAIN_SECRET is unset.
 * A DEDICATED secret (no fallback to another drain's secret): this endpoint spends money, so holding
 * the push-drain secret must not be enough to trigger it. Create it per environment (runbook).
 * The pass runs INSIDE the request (Cloud Run gives CPU only during a request). Reveals only counts.
 */
@Controller('voucher-dispersal')
export class VoucherDispersalDrainController {
  constructor(private readonly processor: VoucherDispersalProcessor) {}

  @Public()
  @Post('drain')
  @HttpCode(200)
  async drain(@Headers('x-drain-secret') secret?: string) {
    const clean = (v?: string) => v?.replace(/^﻿/, '').trim() || undefined;
    const expected = clean(process.env.VOUCHER_DISPERSAL_DRAIN_SECRET);
    if (!expected) throw new ForbiddenException('Drain disabled');
    const got = Buffer.from(secret ?? '');
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ForbiddenException('Invalid drain secret');
    return this.processor.drain({ budgetMs: 45_000 });
  }
}
