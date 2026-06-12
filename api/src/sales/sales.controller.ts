import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SalesService }  from './sales.service';
import { parsePointsAwardExcel } from './excel-parser';
import { Roles }         from '../common/decorators/roles.decorator';
import { CurrentUser }   from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { CreateUploadDto, ProcessRowsDto } from './dto/sales.dto';

@Controller('sales')
export class SalesController {
  constructor(private readonly svc: SalesService) {}

  // ── Ingest: upload Excel + process in one call ────────────────────────────
  //
  // POST /sales/uploads/ingest
  // Content-Type: multipart/form-data
  // Fields:
  //   file   — .xlsx file
  //   month  — (optional) override month for all rows, "YYYY-MM"
  //
  // Flow:
  //   1. Receive file buffer
  //   2. Parse horizontal Excel → PointsAwardRow[]
  //   3. Create SalesUpload record (PENDING)
  //   4. processPointsAwardRows → credits wallets
  //   5. Return ProcessResult

  @Post('uploads/ingest')
  @Roles('ADMIN', 'GIFSY_ADMIN', 'SALES_HO', 'SALES_STATE_HEAD')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
    fileFilter: (_req, file, cb) => {
      const ok = /\.(xlsx|xls)$/i.test(file.originalname);
      cb(ok ? null : new BadRequestException('Only .xlsx / .xls files are accepted'), ok);
    },
  }))
  async ingest(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');

    // Parse Excel
    let rows: ReturnType<typeof parsePointsAwardExcel>;
    try {
      rows = parsePointsAwardExcel(file.buffer);
    } catch (e) {
      throw new BadRequestException(`Excel parse error: ${(e as Error).message}`);
    }

    if (rows.length === 0) {
      throw new BadRequestException('Excel file contains no data rows with non-zero points');
    }

    // Create upload audit record (snapshot uploader identity at this moment)
    const upload = await this.svc.createUpload({
      clientId:          user.clientId,
      uploadedByUserId:  user.sub,
      uploadedByName:    user.name,
      uploadedByPhone:   user.phone,
      fileName:          file.originalname,
      fileUrl:           '',            // no GCS in dev; set to GCS URL in prod
      fileKey:           '',
      fileSizeBytes:     file.size,
    });

    // Credit wallets
    return this.svc.processPointsAwardRows(user.clientId, upload.id, rows);
  }

  // ── Create upload record only (file already on GCS) ───────────────────────

  @Post('uploads')
  @Roles('ADMIN', 'GIFSY_ADMIN', 'SALES_HO', 'SALES_STATE_HEAD')
  createUpload(@Body() dto: CreateUploadDto, @CurrentUser() user: JwtPayload) {
    return this.svc.createUpload({
      ...dto,
      clientId:          user.clientId,
      uploadedByUserId:  user.sub,
      uploadedByName:    user.name,
      uploadedByPhone:   user.phone,
    });
  }

  // ── Process pre-parsed rows (rows already pivoted by caller) ─────────────

  @Post('uploads/:id/process')
  @Roles('ADMIN', 'GIFSY_ADMIN', 'SALES_HO', 'SALES_STATE_HEAD')
  processRows(
    @Param('id') id: string,
    @Body() dto: ProcessRowsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.svc.processPointsAwardRows(user.clientId, id, dto.rows as any);
  }

  // ── List uploads ──────────────────────────────────────────────────────────

  @Get('uploads')
  listUploads(@CurrentUser() user: JwtPayload, @Query() q: any) {
    return this.svc.listUploads(user.clientId, {
      status: q.status,
      page:   q.page  ? +q.page  : 1,
      limit:  q.limit ? +q.limit : 20,
    });
  }
}
