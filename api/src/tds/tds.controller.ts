/**
 * TDS admin read-only endpoints — P6.5a.
 *
 * GET /v1/admin/tds/194r?fy=2025-26  — CLIENT_ADMIN or GIFSY_ADMIN (tenant-scoped)
 * GET /v1/admin/tds/194c?fy=2025-26  — GIFSY_ADMIN only (platform-wide)
 *
 * Excel exports and upload endpoints arrive in 6.5b/c.
 */
import { Controller, Get, Query } from '@nestjs/common';
import { TdsService } from './tds.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { fyOfToday } from './tds.helpers';

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
