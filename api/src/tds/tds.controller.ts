/**
 * TDS admin endpoints — P6.5a + P6.5b + P6.5c.
 *
 * P6.5a (aggregation reads):
 *   GET /v1/admin/tds/194r?fy=2025-26  — CLIENT_ADMIN or GIFSY_ADMIN (tenant-scoped)
 *   GET /v1/admin/tds/194c?fy=2025-26  — GIFSY_ADMIN only (platform-wide)
 *
 * P6.5b (uploads + liability tracker):
 *   GET  /v1/admin/tds/off-platform/template          → blank xlsx
 *   POST /v1/admin/tds/off-platform/upload?apply=true → parse + commit off-platform 194R
 *   GET  /v1/admin/tds/deposits/template              → blank xlsx
 *   POST /v1/admin/tds/deposits/upload?section=194R|194C&apply=true → deposit upload
 *   GET  /v1/admin/tds/liability?section=194R|194C&fy=2025-26       → liability tracker
 *
 * P6.5c (CA-ready reference Excel exports):
 *   GET /v1/admin/tds/194r/export?fy=2025-26  — CLIENT_ADMIN or GIFSY_ADMIN (tenant-scoped)
 *   GET /v1/admin/tds/194c/export?fy=2025-26  — GIFSY_ADMIN only (platform-wide)
 */
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { TdsService } from './tds.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { fyOfToday } from './tds.helpers';
import { DepositUploadQueryDto, LiabilityQueryDto, UploadQueryDto } from './dto/tds.dto';

@Controller('admin/tds')
export class TdsController {
  constructor(private readonly tds: TdsService) {}

  /**
   * 194R summary + rows for the calling client's tenant.
   * GIFSY_ADMIN may pass ?clientId= to view another tenant (defaulting to
   * their own JWT clientId). CLIENT_ADMIN is always scoped to their own tenant.
   */
  @Get('194r')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  async get194R(
    @CurrentUser() user: JwtPayload,
    @Query('fy') fy?: string,
    @Query('clientId') queryClientId?: string,
  ) {
    // CLIENT_ADMIN is always their own tenant; GIFSY_ADMIN can cross-scope via ?clientId=
    const clientId =
      user.role === 'GIFSY_ADMIN' && queryClientId ? queryClientId : user.clientId;

    const fyLabel = fy ?? fyOfToday().fyLabel;
    const [rows, summary] = await Promise.all([
      this.tds.compute194R(clientId, fyLabel),
      this.tds.summary194R(clientId, fyLabel),
    ]);

    return {
      section: '194R',
      fyLabel,
      clientId,
      summary: serializeSummary194R(summary),
      rows: rows.map(serializeRow194R),
    };
  }

  /**
   * 194C summary + rows (platform-wide, Gifsy deductor).
   * GIFSY_ADMIN only — returns rows across ALL tenants for the FY.
   */
  @Get('194c')
  @Roles('GIFSY_ADMIN')
  async get194C(
    @CurrentUser() _user: JwtPayload,
    @Query('fy') fy?: string,
  ) {
    const fyLabel = fy ?? fyOfToday().fyLabel;
    const [rows, summary] = await Promise.all([
      this.tds.compute194C(fyLabel),
      this.tds.summary194C(fyLabel),
    ]);

    return {
      section: '194C',
      fyLabel,
      summary: serializeSummary194C(summary),
      rows: rows.map(serializeRow194C),
    };
  }

  // ─── P6.5c: Excel reference exports ──────────────────────────────────────

  /**
   * GET /v1/admin/tds/194r/export?fy=2025-26
   *
   * CA-ready 194R reference Excel (mirroring the 26Q deductee sheet).
   * Tenant-scoped: CLIENT_ADMIN is always their own tenant; GIFSY_ADMIN may
   * pass ?clientId= to view another tenant's data.
   *
   * Columns: S.No · Deductee Name · PAN · Section (194R) · Amount Paid (₹)
   *          · TDS Rate % · TDS Amount (₹) · Already Deposited (₹) · Outstanding (₹) · FY
   * Plus a Summary sheet (totals).
   * Filename: tds-194r-<fy>.xlsx
   */
  @Get('194r/export')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  async export194R(
    @CurrentUser() user: JwtPayload,
    @Query('fy') fy?: string,
    @Query('clientId') queryClientId?: string,
  ): Promise<StreamableFile> {
    const clientId =
      user.role === 'GIFSY_ADMIN' && queryClientId ? queryClientId : user.clientId;
    const fyLabel = fy ?? fyOfToday().fyLabel;
    const { buffer, filename } = await this.tds.export194R(clientId, fyLabel);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  /**
   * GET /v1/admin/tds/194c/export?fy=2025-26
   *
   * 194C two-column report Excel (platform-wide, Gifsy deductor).
   * GIFSY_ADMIN only.
   *
   * Columns: S.No · Deductee Name · PAN · Entity Type · Section (194C) · Amount Paid (₹)
   *          · TDS Rate % · TDS — With Threshold (₹) · TDS — No Threshold (₹)
   *          · Threshold Met (Y/N) · Already Deposited (₹) · Outstanding (₹) · FY
   * Filename: tds-194c-<fy>.xlsx
   */
  @Get('194c/export')
  @Roles('GIFSY_ADMIN')
  async export194C(
    @CurrentUser() _user: JwtPayload,
    @Query('fy') fy?: string,
  ): Promise<StreamableFile> {
    const fyLabel = fy ?? fyOfToday().fyLabel;
    const { buffer, filename } = await this.tds.export194C(fyLabel);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${filename}"`,
    });
  }

  // ─── P6.5b: Off-platform 194R upload ──────────────────────────────────────

  /**
   * GET /v1/admin/tds/off-platform/template
   * Returns a blank .xlsx with columns: Date · PAN · Outlet Code · Amount (₹)
   * Roles: CLIENT_ADMIN or GIFSY_ADMIN.
   */
  @Get('off-platform/template')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  getOffPlatformTemplate(@Res({ passthrough: true }) res: Response): StreamableFile {
    const buffer = this.tds.offPlatformTemplate();
    res.setHeader('Content-Disposition', 'attachment; filename="tds-off-platform-template.xlsx"');
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  /**
   * POST /v1/admin/tds/off-platform/upload?apply=true|false
   * Multipart xlsx. Preview unless apply=true. Commits to TdsOffPlatformEntry.
   * PAN required; amount > 0; date required.
   * Roles: CLIENT_ADMIN or GIFSY_ADMIN.
   */
  @Post('off-platform/upload')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @UseInterceptors(FileInterceptor('file'))
  async uploadOffPlatform(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Query() query: UploadQueryDto,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const apply = query.apply === 'true';
    return this.tds.uploadOffPlatform(user.clientId, user.sub, file, apply);
  }

  // ─── P6.5b: TDS deposit upload ────────────────────────────────────────────

  /**
   * GET /v1/admin/tds/deposits/template
   * Returns a blank .xlsx with columns: Date · Outlet Code · PAN · Amount (₹)
   * Roles: CLIENT_ADMIN or GIFSY_ADMIN.
   */
  @Get('deposits/template')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  getDepositTemplate(@Res({ passthrough: true }) res: Response): StreamableFile {
    const buffer = this.tds.depositTemplate();
    res.setHeader('Content-Disposition', 'attachment; filename="tds-deposit-template.xlsx"');
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  /**
   * POST /v1/admin/tds/deposits/upload?section=194R|194C&apply=true|false
   * Multipart xlsx. Preview unless apply=true.
   *   section=194R → depositorType=CLIENT, clientId from JWT. Roles: CLIENT_ADMIN or GIFSY_ADMIN.
   *   section=194C → depositorType=GIFSY, clientId=null.   Roles: GIFSY_ADMIN only.
   */
  @Post('deposits/upload')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDeposit(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
    @Query() query: DepositUploadQueryDto,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');

    const section = query.section; // '194R' | '194C' — validated by DTO @IsIn
    if (!section) throw new BadRequestException('?section=194R|194C is required');

    // 194C is GIFSY_ADMIN only
    if (section === '194C' && user.role !== 'GIFSY_ADMIN') {
      throw new ForbiddenException('194C deposits may only be uploaded by GIFSY_ADMIN');
    }

    const apply = query.apply === 'true';
    const clientId = section === '194R' ? user.clientId : null;

    return this.tds.uploadDeposit(section, clientId, user.sub, file, apply);
  }

  // ─── P6.5b: Liability tracker ─────────────────────────────────────────────

  /**
   * GET /v1/admin/tds/liability?section=194R|194C&fy=2025-26
   * Returns per-PAN liability/deposited/outstanding for the section + FY.
   *   194R: tenant-scoped (CLIENT_ADMIN or GIFSY_ADMIN with clientId from JWT).
   *   194C: platform-wide (GIFSY_ADMIN only).
   * Outstanding may be negative (over-deposit) — passed through as-is.
   */
  @Get('liability')
  @Roles('CLIENT_ADMIN', 'GIFSY_ADMIN')
  async getLiability(
    @CurrentUser() user: JwtPayload,
    @Query() query: LiabilityQueryDto,
  ) {
    const section = query.section;
    if (!section) throw new BadRequestException('?section=194R|194C is required');

    if (section === '194C' && user.role !== 'GIFSY_ADMIN') {
      throw new ForbiddenException('194C liability is accessible to GIFSY_ADMIN only');
    }

    const fyLabel = query.fy ?? fyOfToday().fyLabel;
    return this.tds.getLiability(section, fyLabel, user.clientId);
  }
}

// ─── BigInt serialisation helpers ────────────────────────────────────────────
// JSON.stringify can't handle BigInt — convert all paise fields to strings
// (the FE/consumer parses as strings; division by 100 gives ₹ for display).

function serializeRow194R(r: import('./tds.service').TdsRow194R) {
  return {
    panNumber: r.panNumber,
    fyLabel: r.fyLabel,
    baseFyTotalPaise: r.baseFyTotalPaise.toString(),
    liabilityPaise: r.liabilityPaise.toString(),
    depositedPaise: r.depositedPaise.toString(),
    outstandingPaise: r.outstandingPaise.toString(),
  };
}

function serializeRow194C(r: import('./tds.service').TdsRow194C) {
  return {
    panNumber: r.panNumber,
    entityType: r.entityType,
    fyLabel: r.fyLabel,
    baseFyTotalPaise: r.baseFyTotalPaise.toString(),
    maxSinglePaise: r.maxSinglePaise.toString(),
    thresholdMet: r.thresholdMet,
    liabilityPaise: r.liabilityPaise.toString(),
    liabilityNoThresholdPaise: r.liabilityNoThresholdPaise.toString(),
    depositedPaise: r.depositedPaise.toString(),
    outstandingPaise: r.outstandingPaise.toString(),
  };
}

function serializeSummary194R(s: import('./tds.service').TdsSummary194R) {
  return {
    fyLabel: s.fyLabel,
    clientId: s.clientId,
    totalBasePaise: s.totalBasePaise.toString(),
    totalLiabilityPaise: s.totalLiabilityPaise.toString(),
    totalDepositedPaise: s.totalDepositedPaise.toString(),
    totalOutstandingPaise: s.totalOutstandingPaise.toString(),
    rowCount: s.rowCount,
  };
}

function serializeSummary194C(s: import('./tds.service').TdsSummary194C) {
  return {
    fyLabel: s.fyLabel,
    totalBasePaise: s.totalBasePaise.toString(),
    totalLiabilityPaise: s.totalLiabilityPaise.toString(),
    totalLiabilityNoThresholdPaise: s.totalLiabilityNoThresholdPaise.toString(),
    totalDepositedPaise: s.totalDepositedPaise.toString(),
    totalOutstandingPaise: s.totalOutstandingPaise.toString(),
    rowCount: s.rowCount,
  };
}
