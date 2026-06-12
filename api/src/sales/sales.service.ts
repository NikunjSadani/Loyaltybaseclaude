import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { SalesUpload } from '@prisma/client';

interface CreateUploadDto {
  clientId:           string;
  uploadedByUserId:   string;
  uploadedByName?:    string;    // snapshot: uploader name at upload time
  uploadedByPhone?:   string;    // snapshot: uploader phone at upload time
  uploadedByEmpCode?: string;    // snapshot: employee code (sales users only)
  fileName:           string;
  fileUrl:            string;
  fileKey:            string;
  fileSizeBytes?:     number;
}

// ── Points-award row (admin Excel upload) ──────────────────────────────────
// Columns: outletCode | month (YYYY-MM) | parameterName | points

export interface PointsAwardRow {
  outletCode:    string;   // outlet's unique code
  month:         string;   // e.g. "2026-07"
  parameterName: string;   // e.g. "Soybean Oil", "Sunflower Oil"
  points:        number;   // whole points to credit
}

export interface ProcessResult {
  processedRows: number;
  successRows:   number;
  failedRows:    number;
  errors:        string[];
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly prisma:   PrismaService,
    private readonly wallets:  WalletService,
  ) {}

  // ── Create upload record ──────────────────────────────────────────────────

  async createUpload(dto: CreateUploadDto): Promise<SalesUpload> {
    return this.prisma.salesUpload.create({
      data: {
        clientId:           dto.clientId,
        uploadedByUserId:   dto.uploadedByUserId,
        uploadedByName:     dto.uploadedByName,
        uploadedByPhone:    dto.uploadedByPhone,
        uploadedByEmpCode:  dto.uploadedByEmpCode,
        fileName:           dto.fileName,
        fileUrl:            dto.fileUrl,
        fileKey:            dto.fileKey,
        fileSizeBytes:      dto.fileSizeBytes,
        status:             'PENDING' as any,
      },
    });
  }

  // ── Process points-award rows from admin Excel ────────────────────────────
  //
  // Each row credits the outlet's partner wallet immediately.
  // Wallet transaction is tagged with parameterName + month so partners
  // can see individual line items (e.g. "Soybean Oil – 2026-07: 150 pts").

  async processPointsAwardRows(
    clientId: string,
    uploadId: string,
    rows: PointsAwardRow[],
  ): Promise<ProcessResult> {
    const result: ProcessResult = {
      processedRows: 0,
      successRows:   0,
      failedRows:    0,
      errors:        [],
    };

    for (const row of rows) {
      result.processedRows++;

      // Validate points
      if (!row.points || row.points <= 0) {
        result.failedRows++;
        result.errors.push(
          `${row.outletCode} [${row.parameterName}]: points must be positive (got ${row.points})`,
        );
        continue;
      }

      try {
        // Resolve outlet → partner
        const outlet = await this.prisma.outlet.findFirst({
          where: { outletCode: row.outletCode, deletedAt: null },
        });

        if (!outlet) {
          result.failedRows++;
          result.errors.push(`${row.outletCode}: outlet not found`);
          continue;
        }

        // Credit wallet — one transaction per parameter per outlet
        await this.wallets.earnPoints({
          partnerId:     outlet.partnerId,
          points:        row.points,
          referenceType: 'POINTS_AWARD',
          referenceId:   uploadId,
          description:   `${row.parameterName} – ${row.month}`,
        });

        result.successRows++;
      } catch (e) {
        result.failedRows++;
        result.errors.push(`${row.outletCode}: ${(e as Error).message}`);
      }
    }

    // Finalise upload record
    const allFailed = result.failedRows === result.processedRows;
    await this.prisma.salesUpload.update({
      where: { id: uploadId },
      data: {
        status:        (allFailed ? 'FAILED' : 'COMPLETED') as any,
        totalRows:     result.processedRows,
        processedRows: result.processedRows,
        successRows:   result.successRows,
        failedRows:    result.failedRows,
        errorSummary:  result.errors.length ? { errors: result.errors.slice(0, 100) } : undefined,
        processedAt:   new Date(),
      },
    });

    this.logger.log(
      `Upload ${uploadId}: ${result.successRows}/${result.processedRows} rows credited`,
    );
    return result;
  }

  // ── List uploads ──────────────────────────────────────────────────────────

  async listUploads(
    clientId: string,
    opts: { page?: number; limit?: number; status?: string } = {},
  ) {
    const page  = opts.page  ?? 1;
    const limit = opts.limit ?? 20;
    const skip  = (page - 1) * limit;
    const where: any = { clientId };
    if (opts.status) where.status = opts.status;

    const [data, total] = await Promise.all([
      this.prisma.salesUpload.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.salesUpload.count({ where }),
    ]);

    return { data, total, page, totalPages: Math.ceil(total / limit) };
  }
}
