import { Controller, ForbiddenException, Headers, HttpCode, Post } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { SalesImportDrainResult } from './sales-import.contract';
import { hasClaimableImports } from './ingest/claim';
import { SalesImportRunnerService } from './ingest/sales-import-runner.service';
import { SalesImportRetentionService } from './ingest/sales-import-retention.service';

/**
 * POST /v1/sales-import/drain: `@Public`, header `x-drain-secret` = SALES_IMPORT_DRAIN_SECRET,
 * constant-time compare, FAIL-CLOSED when the secret is unset (copy of the kyc.controller.ts pattern).
 * Kicks the worker when QUEUED or heartbeat-stale PROCESSING imports exist (Cloud Scheduler fallback,
 * plan R-9). It never reveals what is queued (only whether a kick happened). OWNER: Lane I.
 *
 * INFRA NOTE (M3 / S5): a Cloud Scheduler job calling this endpoint (e.g. every 10 min, header x-drain-secret) is
 * REQUIRED in staging/prod: it is what recovers an import whose worker died (heartbeat-stale PROCESSING is reclaimed
 * on the next kick) and, when nothing is queued, it drives the retention sweep. See plan §14.
 */
/** Wall-clock budget for the combos-summary repair inside the scheduler's drain request (a started month finishes). */
export const DRAIN_COMBOS_REFRESH_BUDGET_MS = 60_000;

@Controller('sales-import')
export class SalesImportDrainController {
  constructor(
    readonly runner: SalesImportRunnerService,
    readonly prisma: PrismaService,
    readonly retention: SalesImportRetentionService,
  ) {}

  @Public()
  @Post('drain')
  @HttpCode(200)
  async drain(@Headers('x-drain-secret') secret?: string): Promise<SalesImportDrainResult> {
    // Same BOM / trailing-CR hygiene as other Windows-written secrets.
    const expected = process.env.SALES_IMPORT_DRAIN_SECRET?.replace(/^﻿/, '').trim();
    if (!expected) throw new ForbiddenException('Drain disabled');
    const got = Buffer.from(secret ?? '');
    const want = Buffer.from(expected);
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ForbiddenException('Invalid drain secret');
    if (!(await hasClaimableImports(this.prisma))) {
      await this.retention.sweep({ limit: 50 }); // never throws
      // §10c: repair stale combos summaries; budget kept well inside the scheduler's HTTP deadline (never throws).
      await this.retention.refreshHistoryCombos({ budgetMs: DRAIN_COMBOS_REFRESH_BUDGET_MS });
      return { kicked: false };
    }
    return { kicked: (await this.runner.kick()) !== 'none' };
  }
}
