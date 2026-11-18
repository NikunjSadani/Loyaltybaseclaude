import { Controller, ForbiddenException, Headers, HttpCode, Post } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Public } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { SalesImportDrainResult } from './sales-import.contract';
import { hasClaimableImports } from './ingest/claim';
import { SalesImportRunnerService } from './ingest/sales-import-runner.service';
import { SalesImportRetentionService } from './ingest/sales-import-retention.service';
import { SalesApplyJobsService } from './apply/sales-apply-jobs.service';

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
/**
 * The idle drain does its work INSIDE the scheduler's request: nothing is started that could still run after start +
 * DRAIN_DEADLINE_MS (re-check M2), so the response (and every transaction / advisory lock) ends inside the scheduler's
 * 170 s attempt deadline (plan §14) — the API runs with CPU throttling, so work must not outlive the response.
 */
export const DRAIN_DEADLINE_MS = 150_000;

@Controller('sales-import')
export class SalesImportDrainController {
  constructor(
    readonly runner: SalesImportRunnerService,
    readonly prisma: PrismaService,
    readonly retention: SalesImportRetentionService,
    readonly jobs: SalesApplyJobsService,
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
    // Background Apply / Recalculate jobs (2026-11-18) run in the same worker: a queued (or stale) job is a reason to kick.
    if (!(await hasClaimableImports(this.prisma)) && !(await this.jobs.hasClaimable())) {
      const deadline = Date.now() + DRAIN_DEADLINE_MS;
      await this.retention.sweep({ limit: 50, deadline }); // never throws; starts nothing that could pass the deadline
      return { kicked: false };
    }
    return { kicked: (await this.runner.kick()) !== 'none' };
  }
}
